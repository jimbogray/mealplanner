// A PDF copy of each recipe's page, kept in case the site changes or goes offline. Chromium prints the
// page; the PDFs live in Azure Blob Storage.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import puppeteer from "puppeteer-core";
import { isPublicAddress } from "./recipe-meta.js";

/** Prints a web page to PDF. Throws if it can't. */
export type PagePrinter = (url: string) => Promise<Buffer>;

/** Where the PDFs are kept, by name. */
export interface PdfStore {
  put(name: string, pdf: Buffer): Promise<void>;
  /** The PDF, or null if there isn't one by that name. */
  get(name: string): Promise<Buffer | null>;
  delete(name: string): Promise<void>;
}

const LOAD_TIMEOUT_MS = 45_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Whether the page may load this URL: only the public web, never the server itself or its private network. */
async function isPublicUrl(raw: string, seen: Map<string, Promise<boolean>>): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPublicAddress(host);
  let ok = seen.get(host);
  if (!ok) {
    ok = lookup(host, { all: true }).then(
      (addresses) => addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address)),
      () => false,
    );
    seen.set(host, ok);
  }
  return ok;
}

/** Prints pages with the Chromium at `executablePath`, a fresh browser for each page so memory is handed back. */
export function chromiumPrinter(executablePath: string): PagePrinter {
  return async (url) => {
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // The container runs as a plain user without the kernel features Chromium's sandbox needs.
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--mute-audio"],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900 });
      const hosts = new Map<string, Promise<boolean>>();
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        isPublicUrl(req.url(), hosts)
          .then((ok) => (ok ? req.continue() : req.abort("blockedbyclient")))
          .catch(() => {}); // The page has gone (closed, or navigated away).
      });
      const res = await page.goto(url, { waitUntil: "networkidle2", timeout: LOAD_TIMEOUT_MS }).catch(async (err: unknown) => {
        // Pages that never go quiet (ads, live chat) still print fine once they've loaded.
        if (err instanceof Error && err.name === "TimeoutError" && page.url() !== "about:blank") return null;
        throw err;
      });
      if (res && !res.ok()) throw new Error(`The page answered ${res.status()}`);
      // Lazy-loaded photos only load once they're scrolled into view.
      await page
        .evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight && y < 30_000; y += 800) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 100));
          }
          window.scrollTo(0, 0);
        })
        .catch(() => {}); // No body to scroll: print it as it is.
      const pdf = Buffer.from(await page.pdf({ format: "A4", printBackground: true, timeout: LOAD_TIMEOUT_MS }));
      if (pdf.length > MAX_PDF_BYTES) throw new Error(`The PDF is too big (${pdf.length} bytes)`);
      return pdf;
    } finally {
      await browser.close();
    }
  };
}

/**
 * A blob container in Azure Storage at `accountUrl` (https://<account>.blob.core.windows.net), signed in as
 * the app's managed identity (or, on a developer's machine, whoever `az login` is). Creates the container
 * if it isn't there.
 */
export function azureBlobStore(accountUrl: string, containerName: string): PdfStore {
  const container: ContainerClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential()).getContainerClient(containerName);
  let ready: Promise<unknown> | null = null;
  const ensure = () => (ready ??= container.createIfNotExists().catch((err) => ((ready = null), Promise.reject(err))));
  return {
    async put(name, pdf) {
      await ensure();
      await container.getBlockBlobClient(name).uploadData(pdf, { blobHTTPHeaders: { blobContentType: "application/pdf" } });
    },
    async get(name) {
      try {
        return await container.getBlobClient(name).downloadToBuffer();
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) return null;
        throw err;
      }
    },
    async delete(name) {
      await container.getBlobClient(name).deleteIfExists();
    },
  };
}
