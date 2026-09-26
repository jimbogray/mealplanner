import { isLifeStage, type LifeStage } from "@mealplanner/shared";
import { HttpError } from "./http.js";

export function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected a JSON object");
  return body as Record<string, unknown>;
}

export function text(value: unknown, field: string, max = 80): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

export function email(value: unknown): string {
  const e = text(value, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, "Enter a valid email address");
  return e;
}

export const MIN_PASSWORD = 8;

export function password(value: unknown): string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (value.length > 200) throw new HttpError(400, "Password is too long");
  return value;
}

export function lifeStage(value: unknown): LifeStage {
  if (!isLifeStage(value)) throw new HttpError(400, "Choose a life stage: baby, toddler, child, teenager or adult");
  return value;
}

export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(404, "Not found");
  return value;
}

/** A web page address (http or https), without its #fragment. */
export function webUrl(value: unknown, field = "Link"): string {
  const raw = text(value, field, 2048);
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, `${field} must be a web address`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname.includes(".") || u.username || u.password) {
    throw new HttpError(400, `${field} must be a web address`);
  }
  u.hash = "";
  return u.href;
}
