import {
  ALLERGENS,
  isAllergen,
  isDiet,
  isIsoDate,
  isLifeStage,
  MAX_GUESTS,
  type Allergen,
  type Diet,
  type IsoDate,
  type LifeStage,
  type MemberRole,
} from "@mealplanner/shared";
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

export function diet(value: unknown): Diet {
  if (!isDiet(value)) throw new HttpError(400, "Diet must be none, vegetarian or vegan");
  return value;
}

/** A de-duplicated list of known allergens, in ALLERGENS order. */
export function allergies(value: unknown): Allergen[] {
  if (!Array.isArray(value)) throw new HttpError(400, "Allergies must be a list");
  for (const a of value) if (!isAllergen(a)) throw new HttpError(400, `Unknown allergy: ${String(a)}`);
  return ALLERGENS.filter((a) => value.includes(a));
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

/** A text field that may be left out, null or blank. */
export function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  return text(value, field, max);
}

/** Cooking time in whole minutes (up to two days), or null. */
export function optionalMinutes(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2880) {
    throw new HttpError(400, "Cooking time must be a whole number of minutes");
  }
  return value;
}

/** An afternoon or evening time on the hour or half hour, "12:00" to "23:00", or null when left out or blank. */
export function optionalPmHalfHour(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^((1[2-9]|2[0-2]):[03]0|23:00)$/.test(value)) {
    throw new HttpError(400, `${field} must be on the hour or half hour from 12:00 to 23:00, like 18:30`);
  }
  return value;
}

export function role(value: unknown): MemberRole {
  if (value !== "admin" && value !== "member") throw new HttpError(400, "Role must be admin or member");
  return value;
}

/** A calendar date, "YYYY-MM-DD". */
export function isoDate(value: unknown, field = "Date"): IsoDate {
  if (!isIsoDate(value)) throw new HttpError(400, `${field} must be a date like 2026-09-28`);
  return value;
}

/** A star rating: 0 clears it, 1 to 5 sets it. */
export function stars(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
    throw new HttpError(400, "Rating must be a whole number of stars from 0 to 5");
  }
  return value;
}

export function guests(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_GUESTS) {
    throw new HttpError(400, `Guests must be a whole number from 0 to ${MAX_GUESTS}`);
  }
  return value;
}

/** A de-duplicated list of ids (whether they're in the family is checked by the caller). */
export function ids(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be a list`);
  for (const id of value) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new HttpError(400, `${field} has an unknown id`);
    }
  }
  return [...new Set(value.map((id: string) => id.toLowerCase()))];
}

/** Weekdays, 1 (Monday) to 5 (Friday): de-duplicated, in order. */
export function weekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((d) => !Number.isInteger(d) || d < 1 || d > 5)) {
    throw new HttpError(400, "Work-from-home days must be weekdays, 1 (Monday) to 5 (Friday)");
  }
  return [1, 2, 3, 4, 5].filter((d) => value.includes(d));
}
