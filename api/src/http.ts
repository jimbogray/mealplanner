import type { IncomingMessage, ServerResponse } from "node:http";

/** Throw from a handler to send a JSON error with this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: IncomingMessage["headers"];
  query: URLSearchParams;
  body: unknown;
}

export interface Result {
  status?: number;
  body?: unknown;
  /** Sends a 303 to this URL instead of a JSON body. */
  redirect?: string;
  /** Sends this as plain text instead of a JSON body. */
  text?: string;
  /** Lets any web page read the response (for public links other apps call). */
  anyOrigin?: boolean;
}

export type Handler = (req: Request) => Promise<Result>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 64 * 1024;

/** A tiny method + path router; ":name" segments become req.params.name. */
export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => (params[key] = decodeURIComponent(m[i + 1])));
      return { handler: route.handler, params };
    }
    return pathMatched ? "method" : null;
  }
}

/** Parses a JSON body, or a form post (as a string-to-string object). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

/** Adapts a Router to a node:http request listener, with CORS for the web app's origin(s). */
export function listener(router: Router, allowedOrigins: string[]) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type, x-act-as");
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("access-control-max-age", "600");
    }
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      send(res, 204);
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const found = router.match(method, path);
    if (found === null) return send(res, 404, { error: "Not found" });
    if (found === "method") return send(res, 405, { error: "Method not allowed" });

    try {
      const body = method === "GET" ? undefined : await readBody(req);
      const result = await found.handler({ method, path, params: found.params, headers: req.headers, query: url.searchParams, body });
      if (result.anyOrigin) {
        res.setHeader("access-control-allow-origin", "*");
        res.removeHeader("vary");
      }
      if (result.redirect) res.writeHead(303, { location: result.redirect, "cache-control": "no-store" }).end();
      else if (result.text !== undefined) {
        res
          .writeHead(result.status ?? 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
          .end(result.text);
      } else send(res, result.status ?? 200, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
      } else {
        console.error(`${method} ${path} failed`, err);
        send(res, 500, { error: "Something went wrong" });
      }
    }
  };
}
