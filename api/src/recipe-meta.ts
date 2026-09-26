// Fetches a recipe page safely, and reads what can be read without an LLM: the page's title,
// image and site name (schema.org Recipe in JSON-LD first, then Open Graph / Twitter tags, then
// <title>), plus its readable text for the LLM to work from.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export interface RecipeMeta {
  title: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export interface Page {
  /** Where the page ended up after redirects. */
  url: string;
  html: string;
}

/** Downloads a web page. Throws if it can't be read. */
export type PageFetcher = (url: string) => Promise<Page>;

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

// The server fetches URLs people type in, so it must never be pointed at itself or the private network.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  // An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is judged as the IPv4 address it wraps.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const family = isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} isn't a public address`);
  }
}

/** A DNS lookup that refuses private addresses; checked at connect time, so a rebinding DNS answer can't slip past. */
function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new BlockedAddressError(hostname), []);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function get(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) return Promise.reject(new BlockedAddressError(host));
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup: publicLookup as never,
        signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; MealPlanner/0.2; recipe link preview)",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en",
        },
      },
      resolve,
    );
    req.on("error", reject);
  });
}

async function readHtml(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    // The metadata is in <head>; no need for the rest of a huge page.
    if (size >= MAX_BYTES) break;
  }
  res.destroy();
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers["content-type"] ?? "")?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(Buffer.concat(chunks));
}

/** Fetches a public web page's HTML, following redirects. */
export const fetchPage: PageFetcher = async (pageUrl) => {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = new URL(pageUrl);
  for (let hops = 0; ; hops++) {
    const res = await get(url, signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hops >= MAX_REDIRECTS) throw new Error("Too many redirects");
      url = new URL(res.headers.location, url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Redirected to a non-web URL");
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`Page returned ${status}`);
    }
    if (!/html/i.test(res.headers["content-type"] ?? "")) {
      res.resume();
      throw new Error("Not an HTML page");
    }
    return { url: url.href, html: await readHtml(res) };
  }
};

// --- parsing ---------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function clean(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const s = decodeEntities(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function absoluteUrl(value: unknown, base: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(decodeEntities(value.trim()), base);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.href.length > 2048) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** schema.org "image" can be a URL, an ImageObject, or a list of either. */
function jsonLdImage(image: unknown): unknown {
  if (Array.isArray(image)) return jsonLdImage(image[0]);
  if (image && typeof image === "object") return (image as { url?: unknown }).url;
  return image;
}

function isRecipe(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  return type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
}

function findRecipe(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== "object" || depth > 5) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipe(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (isRecipe(obj)) return obj;
  return findRecipe(obj["@graph"], depth + 1) ?? findRecipe(obj.mainEntity, depth + 1);
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return attrs;
}

export function parseRecipeMeta(html: string, pageUrl: string): RecipeMeta {
  let recipe: Record<string, unknown> | null = null;
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      recipe = findRecipe(JSON.parse(m[1]));
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
    if (recipe) break;
  }

  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property ?? a.name)?.toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  return {
    title: clean(recipe?.name) ?? clean(meta["og:title"]) ?? clean(meta["twitter:title"]) ?? clean(titleTag),
    imageUrl:
      absoluteUrl(jsonLdImage(recipe?.image), pageUrl) ??
      absoluteUrl(meta["og:image"], pageUrl) ??
      absoluteUrl(meta["og:image:url"], pageUrl) ??
      absoluteUrl(meta["twitter:image"], pageUrl),
    siteName: clean(meta["og:site_name"], 80),
  };
}

const MAX_TEXT = 60_000;

/**
 * The page as plain text for the LLM: any JSON-LD (often a complete structured recipe) followed by
 * the visible text. Capped so an enormous page (long comment threads…) can't run up the bill.
 */
export function pageText(html: string): string {
  const jsonLd = [...html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
  const visible = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/?(p|div|br|li|h[1-6]|tr|section|article|header|footer)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  const text = [...jsonLd.map((j) => `Structured data:\n${j}`), `Page text:\n${visible}`].join("\n\n");
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

export interface PageImage {
  url: string;
  alt: string | null;
}

const MAX_IMAGES = 20;

/**
 * Candidate photos on the page (for the LLM to pick from when the page's metadata names none):
 * content images only, skipping icons, tracking pixels, SVGs and GIFs.
 */
export function pageImages(html: string, pageUrl: string): PageImage[] {
  const images: PageImage[] = [];
  const seen = new Set<string>();
  const body = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    // Lazy-loading sites keep the real image in a data- attribute.
    const src = a["data-src"] ?? a["data-lazy-src"] ?? a.src ?? a.srcset?.split(",")[0]?.trim().split(/\s+/)[0];
    const url = absoluteUrl(src, pageUrl);
    if (!url || seen.has(url) || /\.(svg|gif)(\?|$)/i.test(url)) continue;
    const width = Number(a.width);
    const height = Number(a.height);
    if ((width && width < 120) || (height && height < 120)) continue;
    if (/(logo|icon|avatar|sprite|pixel|badge|spinner)/i.test(url)) continue;
    seen.add(url);
    images.push({ url, alt: clean(a.alt, 120) });
    if (images.length >= MAX_IMAGES) break;
  }
  return images;
}

export interface PageLink {
  url: string;
  text: string | null;
}

const MAX_LINKS = 150;

/**
 * Links on the page (and embedded frames, where booking widgets usually live), for the LLM to pick
 * from, so any link it returns is one really on the page. http(s) only, de-duplicated.
 */
export function pageLinks(html: string, pageUrl: string): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const body = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<iframe\b[^>]*>/gi)) {
    const a = attributes(m[1] !== undefined ? `<a ${m[1]}>` : m[0]);
    const url = absoluteUrl(m[1] !== undefined ? a.href : a.src, pageUrl);
    if (!url || !/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const text = m[2] === undefined ? "(embedded frame)" : clean(m[2].replace(/<[^>]+>/g, " "), 80);
    links.push({ url, text: text ?? clean(a["aria-label"] ?? a.title, 80) });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}
