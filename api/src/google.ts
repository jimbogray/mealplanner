import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from "node:crypto";

// Verifies Google Identity Services ID tokens (the "credential" the Sign in with
// Google button hands the web app). See
// https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

/** Returns Google's current signing keys, keyed by "kid". */
export type KeySource = () => Promise<Map<string, KeyObject>>;

export class GoogleTokenError extends Error {}

/** Fetches Google's JWKS, caching it for as long as Google's Cache-Control allows. */
export function googleKeySource(fetchImpl: typeof fetch = fetch): KeySource {
  let cached: { keys: Map<string, KeyObject>; expires: number } | null = null;
  return async () => {
    if (cached && cached.expires > Date.now()) return cached.keys;
    const res = await fetchImpl(CERTS_URL);
    if (!res.ok) throw new Error(`Fetching Google certs failed: ${res.status}`);
    const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const keys = new Map(body.keys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: "jwk" })]));
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    cached = { keys, expires: Date.now() + maxAge * 1000 };
    return keys;
  };
}

function decodePart<T>(part: string): T {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    throw new GoogleTokenError("Malformed token");
  }
}

/** Checks the token's RS256 signature, issuer, audience and expiry, and that the email is verified. */
export async function verifyGoogleIdToken(token: string, clientId: string, keys: KeySource, now = Date.now()): Promise<GoogleIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new GoogleTokenError("Malformed token");
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodePart<{ alg?: string; kid?: string }>(headerB64);
  if (header.alg !== "RS256" || !header.kid) throw new GoogleTokenError("Unexpected token algorithm");

  const key = (await keys()).get(header.kid);
  if (!key) throw new GoogleTokenError("Unknown signing key");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  if (!verifier.verify(key, Buffer.from(signatureB64, "base64url"))) throw new GoogleTokenError("Bad signature");

  const claims = decodePart<{
    iss?: string;
    aud?: string;
    exp?: number;
    iat?: number;
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
  }>(payloadB64);
  const nowSec = Math.floor(now / 1000);
  if (!claims.iss || !ISSUERS.has(claims.iss)) throw new GoogleTokenError("Wrong issuer");
  if (claims.aud !== clientId) throw new GoogleTokenError("Token is for a different app");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSec) throw new GoogleTokenError("Token has expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > nowSec) throw new GoogleTokenError("Token issued in the future");
  if (!claims.sub) throw new GoogleTokenError("Token has no subject");
  if (!claims.email || !(claims.email_verified === true || claims.email_verified === "true")) {
    throw new GoogleTokenError("Google account email isn't verified");
  }
  return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name?.trim() || null };
}
