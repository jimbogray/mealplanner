import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { HttpError, type Request } from "./http.js";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
export const SESSION_DAYS = 30;

/** Returns "scrypt$N$r$p$salt$hash" (base64 salt and hash). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a session and returns the bearer token (only its hash is stored). */
export async function createSession(db: Pick<Db, "query">, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO session (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS],
  );
  return token;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  const m = header && /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/** Resolves the signed-in user from the Authorization header, or throws 401. */
export async function requireUser(db: Db, req: Request): Promise<{ userId: string; email: string }> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "Please sign in");
  const { rows } = await db.query<{ user_id: string; email: string }>(
    `SELECT s.user_id, u.email FROM session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!rows[0]) throw new HttpError(401, "Your session has expired, please sign in again");
  return { userId: rows[0].user_id, email: rows[0].email };
}

// No 0/O or 1/I/L, so codes survive being read aloud or retyped.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A 12-character invite code (~59 bits of randomness). */
export function newInviteCode(): string {
  let code = "";
  for (let i = 0; i < 12; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}
