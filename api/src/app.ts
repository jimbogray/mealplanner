import { createServer, type Server } from "node:http";
import {
  addDays,
  canSignIn,
  daysToPlan,
  isIsoDate,
  mondayOf,
  nextWeekToAdd,
  type Address,
  type AddressSearchResponse,
  weekDays,
  type AuthResponse,
  type Family,
  type FamilyMember,
  type FavouriteRecipe,
  type Invite,
  type InvitePreview,
  type LifeStage,
  type Me,
  type RecipePreview,
  type Restaurant,
  type ScheduleDay,
  type ScheduleWeek,
} from "@mealplanner/shared";
import { AddressSearchError, type AddressSearch, type FoundPlace } from "./places.js";
import { createSession, hashPassword, hashToken, bearerToken, newInviteCode, requireUser, verifyPassword } from "./auth.js";
import { withTransaction, type Db, type Tx } from "./db.js";
import { GoogleTokenError, verifyGoogleIdToken, type GoogleIdentity, type KeySource } from "./google.js";
import { HttpError, listener, Router, type Request } from "./http.js";
import { fetchPage, pageImages, pageLinks, pageText, parseRecipeMeta, type PageFetcher } from "./recipe-meta.js";
import type { Maps } from "./maps.js";
import type { RecipeReader } from "./recipe-reader.js";
import type { RestaurantReader } from "./restaurant-reader.js";
import * as v from "./validate.js";

export const INVITE_DAYS = 14;

type Queryable = Pick<Db, "query">;

interface MemberRow {
  id: string;
  family_id: string;
  user_id: string | null;
  name: string;
  life_stage: FamilyMember["lifeStage"];
  diet: FamilyMember["diet"];
  allergies: FamilyMember["allergies"];
  role: FamilyMember["role"];
  email: string | null;
  created_at: Date;
}

const MEMBER_SELECT = `SELECT m.id, m.family_id, m.user_id, m.name, m.life_stage, m.diet, m.allergies, m.role, u.email, m.created_at
  FROM family_member m LEFT JOIN app_user u ON u.id = m.user_id`;

function toMember(r: MemberRow): FamilyMember {
  return {
    id: r.id,
    name: r.name,
    lifeStage: r.life_stage,
    diet: r.diet,
    allergies: r.allergies,
    role: r.role,
    hasAccount: r.user_id !== null,
    email: r.email,
    createdAt: r.created_at.toISOString(),
  };
}

interface FamilyRow {
  id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  address_latitude: number | null;
  address_longitude: number | null;
  created_at: Date;
}

function toAddress(r: FamilyRow): Address | null {
  if (!r.address_line1 || !r.address_city || !r.address_state || !r.address_zip) return null;
  return {
    line1: r.address_line1,
    line2: r.address_line2,
    city: r.address_city,
    state: r.address_state,
    zip: r.address_zip,
    latitude: r.address_latitude,
    longitude: r.address_longitude,
  };
}

async function loadMe(db: Queryable, userId: string, email: string, addressSearch: boolean): Promise<Me> {
  const user = { id: userId, email };
  const self = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [userId])).rows[0];
  if (!self) return { user, family: null, member: null, members: [], addressSearch };
  const fam = (await db.query<FamilyRow>("SELECT * FROM family WHERE id = $1", [self.family_id])).rows[0];
  const members = (
    await db.query<MemberRow>(
      `${MEMBER_SELECT} WHERE m.family_id = $1
        ORDER BY array_position(ARRAY['adult','teenager','child','toddler','baby']::life_stage[], m.life_stage), m.created_at`,
      [self.family_id],
    )
  ).rows.map(toMember);
  const family: Family = { id: fam.id, name: fam.name, address: toAddress(fam), createdAt: fam.created_at.toISOString() };
  return { user, family, member: toMember(self), members, addressSearch };
}

/** The signed-in user's own family_member row, or 403 if they aren't in a family. */
async function requireMember(db: Db, req: Request): Promise<{ userId: string; email: string; member: MemberRow }> {
  const user = await requireUser(db, req);
  const member = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [user.userId])).rows[0];
  if (!member) throw new HttpError(403, "You're not part of a family yet");
  return { ...user, member };
}

async function requireAdmin(db: Db, req: Request) {
  const ctx = await requireMember(db, req);
  if (ctx.member.role !== "admin") throw new HttpError(403, "Only a Family Manager can do that");
  return ctx;
}

/** Loads a member of the caller's family, or 404. */
async function familyMember(db: Queryable, familyId: string, id: string): Promise<MemberRow> {
  const row = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.id = $1 AND m.family_id = $2`, [v.uuid(id), familyId]))
    .rows[0];
  if (!row) throw new HttpError(404, "That family member doesn't exist");
  return row;
}

/** Family Managers who can actually sign in (a manager added without a login can't manage anything yet). */
async function adminCount(db: Queryable, familyId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM family_member WHERE family_id = $1 AND role = 'admin' AND user_id IS NOT NULL",
    [familyId],
  );
  return rows[0].n;
}

/** The new member's name and life stage, validated only when a new member row is actually created. */
type Profile = () => { name: string; lifeStage: LifeStage };

function profileFrom(b: Record<string, unknown>, fallbackName: string | null = null): Profile {
  return () => ({
    name: v.text(typeof b.name === "string" && b.name.trim() ? b.name : fallbackName, "Your name"),
    lifeStage: v.lifeStage(b.lifeStage),
  });
}

async function createFamily(tx: Tx, userId: string, familyName: string, profile: Profile): Promise<void> {
  const { name, lifeStage } = profile();
  const { rows } = await tx.query<{ id: string }>("INSERT INTO family (name) VALUES ($1) RETURNING id", [familyName]);
  await tx.query(
    "INSERT INTO family_member (family_id, user_id, name, life_stage, role) VALUES ($1, $2, $3, $4, 'admin')",
    [rows[0].id, userId, name, lifeStage],
  );
}

/**
 * Uses up an invite and adds the user to its family: as the invite's existing member if it
 * names one, otherwise as a new member. Locks the invite row so a code can't be used twice.
 */
async function acceptInvite(tx: Tx, code: string, userId: string, profile: Profile): Promise<void> {
  const invite = (
    await tx.query<{ id: string; family_id: string; member_id: string | null; accepted_at: Date | null; expired: boolean }>(
      "SELECT id, family_id, member_id, accepted_at, expires_at <= now() AS expired FROM invite WHERE code = $1 FOR UPDATE",
      [code.trim().toUpperCase()],
    )
  ).rows[0];
  if (!invite) throw new HttpError(404, "That invite link isn't valid");
  if (invite.accepted_at) throw new HttpError(410, "That invite link has already been used");
  if (invite.expired) throw new HttpError(410, "That invite link has expired, ask for a new one");
  let memberId: string;
  if (invite.member_id) {
    const { rows } = await tx.query<{ id: string }>(
      "UPDATE family_member SET user_id = $1 WHERE id = $2 AND user_id IS NULL RETURNING id",
      [userId, invite.member_id],
    );
    if (!rows[0]) throw new HttpError(410, "That person already has their own login");
    memberId = rows[0].id;
  } else {
    const { name, lifeStage } = profile();
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO family_member (family_id, user_id, name, life_stage, role) VALUES ($1, $2, $3, $4, 'member') RETURNING id",
      [invite.family_id, userId, name, lifeStage],
    );
    memberId = rows[0].id;
  }
  await tx.query("UPDATE invite SET accepted_by = $1, accepted_at = now() WHERE id = $2", [memberId, invite.id]);
}

interface InviteRow {
  id: string;
  code: string;
  member_id: string | null;
  member_name: string | null;
  created_at: Date;
  expires_at: Date;
}

function toInvite(r: InviteRow): Invite {
  return {
    id: r.id,
    code: r.code,
    memberId: r.member_id,
    memberName: r.member_name,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface AppOptions {
  /** Origins allowed to call the API from a browser. */
  webOrigins: string[];
  /** Enables Sign in with Google when set. */
  google?: { clientId: string; keys: KeySource };
  /** Downloads recipe pages; defaults to fetching them from the web. */
  fetchPage?: PageFetcher;
  /** Reads a recipe's details from its page with an LLM. Without it, people type the details in. */
  readRecipe?: RecipeReader;
  /** Finds restaurants on the map and times the drive from home. Without it, there are no driving times. */
  maps?: Maps;
  /** Reads a restaurant's web page for its cuisine, address and booking link. Without it, people type them in. */
  readRestaurant?: RestaurantReader;
  /** Finds UK addresses as people type (Google Places). Without it, the home address can't be set. */
  addressSearch?: AddressSearch;
}

/** A web app's random id for one address search (see AddressSearchRequest). */
function sessionToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw new HttpError(400, "Missing search session");
  return value;
}

/** Runs a Google Places call, turning its failures into a friendly 502. */
async function searching<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof AddressSearchError)) throw err;
    console.error("Address search failed", err.message);
    throw new HttpError(502, "Couldn't search for addresses just now, try again in a moment");
  }
}

/** Optional sign-up fields: a new family name, or an invite code to join one. */
function familyChoice(b: Record<string, unknown>): { familyName: string | null; inviteCode: string | null } {
  const familyName = typeof b.familyName === "string" && b.familyName.trim() ? v.text(b.familyName, "Family name") : null;
  const inviteCode = typeof b.inviteCode === "string" && b.inviteCode.trim() ? b.inviteCode : null;
  return { familyName, inviteCode };
}

interface RecipeRow {
  id: string;
  url: string;
  name: string;
  description: string | null;
  cooking_minutes: number | null;
  main_protein: string | null;
  image_url: string | null;
  site_name: string | null;
  prepared: boolean;
  average_rating: string | null;
  rating_count: number;
  my_rating: number | null;
  added_by: string | null;
  created_at: Date;
}

/** Selects recipes with their ratings; `me` is the placeholder (e.g. "$2") for the caller's member id. */
function recipeSelect(me: string): string {
  return `SELECT r.id, r.url, r.name, r.description, r.cooking_minutes, r.main_protein, r.image_url, r.site_name,
    r.prepared, m.name AS added_by, r.created_at,
    (SELECT round(avg(stars), 1) FROM recipe_rating WHERE recipe_id = r.id) AS average_rating,
    (SELECT count(*)::int FROM recipe_rating WHERE recipe_id = r.id) AS rating_count,
    (SELECT stars FROM recipe_rating WHERE recipe_id = r.id AND member_id = ${me}) AS my_rating
  FROM favourite_recipe r LEFT JOIN family_member m ON m.id = r.added_by`;
}

function toRecipe(r: RecipeRow): FavouriteRecipe {
  return {
    id: r.id,
    url: r.url,
    name: r.name,
    description: r.description,
    cookingMinutes: r.cooking_minutes,
    mainProtein: r.main_protein,
    imageUrl: r.image_url,
    siteName: r.site_name,
    prepared: r.prepared,
    averageRating: r.average_rating === null ? null : Number(r.average_rating),
    ratingCount: r.rating_count,
    myRating: r.my_rating,
    addedBy: r.added_by,
    createdAt: r.created_at.toISOString(),
  };
}

interface RestaurantRow {
  id: string;
  name: string;
  url: string | null;
  notes: string | null;
  address: string | null;
  cuisine: string | null;
  booking_url: string | null;
  drive_minutes: number | null;
  average_rating: string | null;
  rating_count: number;
  my_rating: number | null;
  added_by: string | null;
  created_at: Date;
}

/** Selects restaurants with their ratings; `me` is the placeholder (e.g. "$2") for the caller's member id. */
function restaurantSelect(me: string): string {
  return `SELECT r.id, r.name, r.url, r.notes, r.address, r.cuisine, r.booking_url, r.drive_minutes, m.name AS added_by, r.created_at,
    (SELECT round(avg(stars), 1) FROM restaurant_rating WHERE restaurant_id = r.id) AS average_rating,
    (SELECT count(*)::int FROM restaurant_rating WHERE restaurant_id = r.id) AS rating_count,
    (SELECT stars FROM restaurant_rating WHERE restaurant_id = r.id AND member_id = ${me}) AS my_rating
  FROM restaurant r LEFT JOIN family_member m ON m.id = r.added_by`;
}

function toRestaurant(r: RestaurantRow): Restaurant {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    notes: r.notes,
    address: r.address,
    cuisine: r.cuisine,
    bookingUrl: r.booking_url,
    driveMinutes: r.drive_minutes,
    averageRating: r.average_rating === null ? null : Number(r.average_rating),
    ratingCount: r.rating_count,
    myRating: r.my_rating,
    addedBy: r.added_by,
    createdAt: r.created_at.toISOString(),
  };
}

interface RestaurantLocation {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  drive_minutes: number | null;
}

interface RestaurantInput {
  name: string;
  url: string | null;
  notes: string | null;
  address: string | null;
  cuisine: string | null;
  bookingUrl: string | null;
  /** An address suggestion the person picked (see /api/family/restaurants/address/search). */
  picked: { placeId: string; sessionToken: string } | null;
}

function optionalWebUrl(value: unknown, field: string): string | null {
  return value == null || (typeof value === "string" && !value.trim()) ? null : v.webUrl(value, field);
}

/** A restaurant's details, as added or edited. */
function restaurantInput(body: unknown): RestaurantInput {
  const b = v.object(body);
  return {
    name: v.text(b.name, "Restaurant name", 120),
    url: optionalWebUrl(b.url, "Restaurant link"),
    notes: v.optionalText(b.notes, "Notes", 1000),
    address: v.optionalText(b.address, "Address", 200),
    cuisine: v.optionalText(b.cuisine, "Cuisine", 60),
    bookingUrl: optionalWebUrl(b.bookingUrl, "Booking link"),
    picked: b.placeId == null ? null : { placeId: v.text(b.placeId, "Address", 1000), sessionToken: sessionToken(b.sessionToken) },
  };
}

/**
 * Fills in whatever the person left blank (cuisine, address, booking link) from the restaurant's web page,
 * read by Claude. What they typed always wins; a page that can't be read, or isn't a restaurant's, changes nothing.
 */
async function fillFromPage(options: Pick<AppOptions, "fetchPage" | "readRestaurant">, r: RestaurantInput): Promise<RestaurantInput> {
  if (!r.url || !options.readRestaurant || (r.cuisine && r.address && r.bookingUrl)) return r;
  try {
    const page = await (options.fetchPage ?? fetchPage)(r.url);
    const links = pageLinks(page.html, page.url);
    const found = await options.readRestaurant({ url: page.url, text: pageText(page.html), links });
    if (!found.isRestaurant) return r;
    // Only a link that's really on the page, so a made-up one can't slip through.
    const booking = links.find((l) => l.url === found.bookingUrl?.trim())?.url ?? null;
    return {
      ...r,
      cuisine: r.cuisine ?? (found.cuisine?.trim().slice(0, 60) || null),
      address: r.address ?? (found.address?.trim().slice(0, 200) || null),
      bookingUrl: r.bookingUrl ?? booking,
    };
  } catch (err) {
    console.error("Reading a restaurant's page failed", err);
    return r;
  }
}

/**
 * Where the family lives, for driving times: the coordinates saved with the home address, or (for an address
 * typed in before address search) the address found on the map. Null without a home address.
 */
async function homeLocation(db: Queryable, maps: Maps | undefined, familyId: string): Promise<{ lat: number; lng: number } | null> {
  const home = (
    await db.query<{ lat: number | null; lng: number | null; address: string | null }>(
      `SELECT address_latitude AS lat, address_longitude AS lng,
         nullif(concat_ws(', ', address_line1, address_line2, address_city, concat_ws(' ', address_state, address_zip)), '') AS address
       FROM family WHERE id = $1`,
      [familyId],
    )
  ).rows[0];
  if (!home?.address) return null;
  if (home.lat !== null && home.lng !== null) return { lat: home.lat, lng: home.lng };
  if (!maps) return null;
  try {
    const place = await maps.findPlace(home.address);
    return place && { lat: place.lat, lng: place.lng };
  } catch (err) {
    console.error("Finding the family's home on the map failed", err);
    return null;
  }
}

/**
 * Finds a restaurant on the map (by its address, or else by name near home) and times the drive from home.
 * Anything the map service can't find, or a failure reaching it, just leaves those details empty.
 */
async function locateRestaurant(
  maps: Maps | undefined,
  home: { lat: number; lng: number } | null,
  r: { name: string; address: string | null },
  picked: FoundPlace | null = null,
): Promise<RestaurantLocation> {
  if (picked) {
    // Picked from the address suggestions, so it's already on the map.
    const location: RestaurantLocation = { address: picked.address, latitude: picked.lat, longitude: picked.lng, drive_minutes: null };
    if (maps && home) {
      try {
        location.drive_minutes = await maps.driveMinutes(home, picked);
      } catch (err) {
        console.error("Working out a driving time failed", err);
      }
    }
    return location;
  }
  const location: RestaurantLocation = { address: r.address, latitude: null, longitude: null, drive_minutes: null };
  // Searching by name alone only makes sense near home.
  if (!maps || (!r.address && !home)) return location;
  try {
    const place = await maps.findPlace(r.address ?? r.name, home);
    if (!place) return location;
    Object.assign(location, { address: r.address ?? place.address, latitude: place.lat, longitude: place.lng });
    if (home) location.drive_minutes = await maps.driveMinutes(home, place);
  } catch (err) {
    console.error("Finding a restaurant on the map failed", err);
  }
  return location;
}

interface ScheduleRow {
  id: string;
  starts_on: string;
  day: string;
  guests: number;
  eat_out: boolean;
  member_ids: string[];
}

/** The family's weeks (or just the one starting on `startsOn`), oldest first, each with its seven days. */
async function loadWeeks(db: Queryable, familyId: string, startsOn?: string): Promise<ScheduleWeek[]> {
  const { rows } = await db.query<ScheduleRow>(
    `SELECT w.id, to_char(w.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(d.day, 'YYYY-MM-DD') AS day, d.guests, d.eat_out,
            coalesce(array_agg(s.member_id::text ORDER BY s.member_id) FILTER (WHERE s.member_id IS NOT NULL), '{}') AS member_ids
       FROM schedule_week w
       JOIN schedule_day d ON d.week_id = w.id
       LEFT JOIN schedule_diner s ON s.week_id = d.week_id AND s.day = d.day
      WHERE w.family_id = $1 AND ($2::date IS NULL OR w.starts_on = $2::date)
      GROUP BY w.id, w.starts_on, d.day, d.guests, d.eat_out
      ORDER BY w.starts_on, d.day`,
    [familyId, startsOn ?? null],
  );
  const weeks: ScheduleWeek[] = [];
  for (const r of rows) {
    if (weeks.at(-1)?.id !== r.id) weeks.push({ id: r.id, startsOn: r.starts_on, days: [] });
    weeks.at(-1)!.days.push({ date: r.day, eatOut: r.eat_out, memberIds: r.member_ids, guests: r.guests });
  }
  return weeks;
}

async function familyMemberIds(db: Queryable, familyId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM family_member WHERE family_id = $1 ORDER BY created_at", [familyId]);
  return rows.map((r) => r.id);
}

/** Who's joining and how many guests, checked against the family's members. Eating out clears both. */
function dinner(b: Record<string, unknown>, familyIds: string[]): Omit<ScheduleDay, "date"> {
  if (b.eatOut !== undefined && typeof b.eatOut !== "boolean") throw new HttpError(400, "Eat out must be true or false");
  if (b.eatOut) return { eatOut: true, memberIds: [], guests: 0 };
  const memberIds = v.ids(b.memberIds, "Who's joining");
  if (memberIds.some((id) => !familyIds.includes(id))) throw new HttpError(400, "Only members of your family can join for dinner");
  return { eatOut: false, memberIds, guests: v.guests(b.guests) };
}

async function saveDay(tx: Tx, weekId: string, day: ScheduleDay): Promise<void> {
  await tx.query(
    `INSERT INTO schedule_day (week_id, day, guests, eat_out) VALUES ($1, $2, $3, $4)
     ON CONFLICT (week_id, day) DO UPDATE SET guests = EXCLUDED.guests, eat_out = EXCLUDED.eat_out`,
    [weekId, day.date, day.guests, day.eatOut],
  );
  await tx.query("DELETE FROM schedule_diner WHERE week_id = $1 AND day = $2", [weekId, day.date]);
  await tx.query(
    "INSERT INTO schedule_diner (week_id, day, member_id) SELECT $1, $2, unnest($3::uuid[])",
    [weekId, day.date, day.memberIds],
  );
}

/** A Monday from the path, or 404. */
function weekStart(value: string): string {
  if (!isIsoDate(value) || mondayOf(value) !== value) throw new HttpError(404, "That week isn't in your schedule");
  return value;
}

export function buildRouter(
  db: Db,
  options: Pick<AppOptions, "google" | "fetchPage" | "readRecipe" | "addressSearch" | "maps" | "readRestaurant"> & { webOrigins?: string[] } = {},
): Router {
  const router = new Router();
  const me = (userId: string, email: string) => loadMe(db, userId, email, options.addressSearch !== undefined);
  const requireAddressSearch = (): AddressSearch => {
    if (!options.addressSearch) throw new HttpError(503, "Address search isn't set up yet");
    return options.addressSearch;
  };

  router.add("GET", "/api/health", async () => {
    await db.query("SELECT 1");
    return { body: { ok: true } };
  });

  // --- accounts ---------------------------------------------------------

  router.add("POST", "/api/auth/signup", async (req) => {
    const b = v.object(req.body);
    const email = v.email(b.email);
    const password = v.password(b.password);
    const profile = profileFrom(b);
    const { familyName, inviteCode } = familyChoice(b);
    if (!inviteCode) profile(); // Validate before the (slow) password hash.
    if (!familyName && !inviteCode) throw new HttpError(400, "Family name is required");

    const passwordHash = await hashPassword(password);
    const { userId, token } = await withTransaction(db, async (tx) => {
      let userId: string;
      try {
        userId = (
          await tx.query<{ id: string }>("INSERT INTO app_user (email, password_hash) VALUES ($1, $2) RETURNING id", [
            email,
            passwordHash,
          ])
        ).rows[0].id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "An account with that email already exists, sign in instead");
        throw err;
      }
      if (inviteCode) await acceptInvite(tx, inviteCode, userId, profile);
      else await createFamily(tx, userId, familyName!, profile);
      return { userId, token: await createSession(tx, userId) };
    });
    const body: AuthResponse = { token, me: await me(userId, email) };
    return { status: 201, body };
  });

  router.add("POST", "/api/auth/login", async (req) => {
    const b = v.object(req.body);
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const user = (
      await db.query<{ id: string; email: string; password_hash: string | null }>(
        "SELECT id, email, password_hash FROM app_user WHERE lower(email) = $1",
        [email],
      )
    ).rows[0];
    if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, "Email or password is incorrect");
    }
    const token = await createSession(db, user.id);
    const body: AuthResponse = { token, me: await me(user.id, user.email) };
    return { body };
  });

  // Sign in (or sign up) with a Google ID token from the web app's Google button.
  // Signing up also needs lifeStage plus familyName or inviteCode, like /api/auth/signup.
  router.add("POST", "/api/auth/google", async (req) => {
    const google = options.google;
    if (!google) throw new HttpError(404, "Google sign-in isn't set up");
    const b = v.object(req.body);
    if (typeof b.credential !== "string" || !b.credential) throw new HttpError(400, "Missing Google credential");
    let identity: GoogleIdentity;
    try {
      identity = await verifyGoogleIdToken(b.credential, google.clientId, google.keys);
    } catch (err) {
      if (err instanceof GoogleTokenError) throw new HttpError(401, `Google sign-in failed: ${err.message}`);
      throw err;
    }
    const { familyName, inviteCode } = familyChoice(b);
    const profile = profileFrom(b, identity.name);

    const result = await withTransaction(db, async (tx) => {
      // Prefer the account already linked to this Google id; otherwise one with the same (Google-verified) email.
      const existing = (
        await tx.query<{ id: string; google_sub: string | null }>(
          `SELECT id, google_sub FROM app_user WHERE google_sub = $1 OR lower(email) = $2
            ORDER BY (google_sub = $1) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
          [identity.sub, identity.email],
        )
      ).rows[0];

      if (existing) {
        if (existing.google_sub === null) {
          await tx.query("UPDATE app_user SET google_sub = $1 WHERE id = $2", [identity.sub, existing.id]);
        } else if (existing.google_sub !== identity.sub) {
          throw new HttpError(409, "That email is already linked to a different Google account");
        }
        // Opening an invite link while not in a family joins it.
        if (inviteCode) {
          const inFamily = (await tx.query("SELECT 1 FROM family_member WHERE user_id = $1", [existing.id])).rowCount;
          if (!inFamily) await acceptInvite(tx, inviteCode, existing.id, profile);
        }
        return { userId: existing.id, created: false };
      }

      if (!familyName && !inviteCode) {
        throw new HttpError(404, "No account uses that Google address yet. Create a family, or open your invite link, to sign up.");
      }
      const userId = (
        await tx.query<{ id: string }>("INSERT INTO app_user (email, google_sub) VALUES ($1, $2) RETURNING id", [
          identity.email,
          identity.sub,
        ])
      ).rows[0].id;
      if (inviteCode) await acceptInvite(tx, inviteCode, userId, profile);
      else await createFamily(tx, userId, familyName!, profile);
      return { userId, created: true };
    });

    const token = await createSession(db, result.userId);
    const email = (await db.query<{ email: string }>("SELECT email FROM app_user WHERE id = $1", [result.userId])).rows[0].email;
    const body: AuthResponse = { token, me: await me(result.userId, email) };
    return { status: result.created ? 201 : 200, body };
  });

  // Google's full-page ("redirect" mode) sign-in, used on iPhones and iPads where its popup fails,
  // form-posts the ID token here. Hand it to the web app's /auth/google page in the URL fragment
  // (never sent to a server); that page checks the nonce it started with and calls /api/auth/google.
  router.add("POST", "/api/auth/google/redirect", async (req) => {
    const webOrigin = options.webOrigins?.[0];
    if (!options.google || !webOrigin) throw new HttpError(404, "Google sign-in isn't set up");
    const credential = (req.body as Record<string, unknown> | undefined)?.credential;
    const fragment =
      typeof credential === "string" && credential
        ? new URLSearchParams({ credential })
        : new URLSearchParams({ error: "Google didn't send a sign-in. Please try again." });
    return { redirect: `${webOrigin}/auth/google#${fragment}` };
  });

  router.add("POST", "/api/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) await db.query("DELETE FROM session WHERE token_hash = $1", [hashToken(token)]);
    return { status: 204 };
  });

  router.add("GET", "/api/me", async (req) => {
    const { userId, email } = await requireUser(db, req);
    return { body: await me(userId, email) };
  });

  // --- family -----------------------------------------------------------

  // For a signed-in user who isn't in a family (e.g. they were removed from one).
  router.add("POST", "/api/family", async (req) => {
    const { userId, email } = await requireUser(db, req);
    const b = v.object(req.body);
    const familyName = v.text(b.familyName, "Family name");
    const profile = profileFrom(b);
    profile();
    await withTransaction(db, async (tx) => {
      try {
        await createFamily(tx, userId, familyName, profile);
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "You're already part of a family");
        throw err;
      }
    });
    return { status: 201, body: await me(userId, email) };
  });

  router.add("PATCH", "/api/family", async (req) => {
    const { member } = await requireAdmin(db, req);
    const name = v.text(v.object(req.body).name, "Family name");
    await db.query("UPDATE family SET name = $1 WHERE id = $2", [name, member.family_id]);
    return { status: 204 };
  });

  // Google is called from the API, not the browser, so its key stays on the server and the
  // coordinates saved are Google's own.
  router.add("PUT", "/api/family/address", async (req) => {
    const { member } = await requireAdmin(db, req);
    const search = requireAddressSearch();
    const b = v.object(req.body);
    const placeId = v.text(b.placeId, "Address", 1000);
    const a = await searching(() => search.details(placeId, sessionToken(b.sessionToken)));
    if (!a) throw new HttpError(400, "Choose a full US street address with a ZIP code");
    await db.query(
      `UPDATE family SET address_line1 = $1, address_line2 = $2, address_city = $3, address_state = $4, address_zip = $5,
          address_latitude = $6, address_longitude = $7
        WHERE id = $8`,
      [a.line1, a.line2, a.city, a.state, a.zip, a.latitude, a.longitude, member.family_id],
    );
    return { body: a };
  });

  router.add("DELETE", "/api/family/address", async (req) => {
    const { member } = await requireAdmin(db, req);
    await db.query(
      `UPDATE family SET address_line1 = NULL, address_line2 = NULL, address_city = NULL, address_state = NULL, address_zip = NULL,
          address_latitude = NULL, address_longitude = NULL
        WHERE id = $1`,
      [member.family_id],
    );
    return { status: 204 };
  });

  router.add("POST", "/api/family/address/search", async (req) => {
    await requireAdmin(db, req);
    const search = requireAddressSearch();
    const b = v.object(req.body);
    const input = v.text(b.input, "Address", 200);
    const body: AddressSearchResponse = { suggestions: await searching(() => search.suggest(input, sessionToken(b.sessionToken))) };
    return { body };
  });

  // Add someone without a login. They can stay that way (a baby, a toddler) or be sent an
  // invite for this member later to sign in as themselves.
  router.add("POST", "/api/family/members", async (req) => {
    const { member } = await requireAdmin(db, req);
    const b = v.object(req.body);
    const name = v.text(b.name, "Name");
    const lifeStage = v.lifeStage(b.lifeStage);
    const diet = b.diet === undefined ? "none" : v.diet(b.diet);
    const allergies = b.allergies === undefined ? [] : v.allergies(b.allergies);
    // A Co-Manager is another Family Manager; they can manage the family once they sign in.
    const role = b.role === undefined ? "member" : v.role(b.role);
    if (role === "admin" && !canSignIn(lifeStage)) throw new HttpError(400, "Only adults and teenagers can be Co-Managers");
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO family_member (family_id, name, life_stage, diet, allergies, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [member.family_id, name, lifeStage, diet, allergies, role],
    );
    return { status: 201, body: toMember(await familyMember(db, member.family_id, rows[0].id)) };
  });

  // Admins can edit anyone; everyone can edit their own name, life stage, diet and allergies.
  router.add("PATCH", "/api/family/members/:id", async (req) => {
    const { member: self } = await requireMember(db, req);
    const target = await familyMember(db, self.family_id, req.params.id);
    const isSelf = target.id === self.id;
    if (self.role !== "admin" && !isSelf) throw new HttpError(403, "Only a Family Manager can change other members");

    const b = v.object(req.body);
    const name = b.name === undefined ? target.name : v.text(b.name, "Name");
    const lifeStage = b.lifeStage === undefined ? target.life_stage : v.lifeStage(b.lifeStage);
    const diet = b.diet === undefined ? target.diet : v.diet(b.diet);
    const allergies = b.allergies === undefined ? target.allergies : v.allergies(b.allergies);
    let role = target.role;
    if (b.role !== undefined) {
      const newRole = v.role(b.role);
      if (self.role !== "admin") throw new HttpError(403, "Only a Family Manager can choose who manages the family");
      if (newRole === "admin" && target.role !== "admin" && !target.user_id && !canSignIn(lifeStage)) {
        throw new HttpError(400, "Only adults and teenagers can be Family Managers");
      }
      if (newRole === "member" && target.role === "admin" && target.user_id && (await adminCount(db, self.family_id)) <= 1) {
        throw new HttpError(400, "A family needs at least one Family Manager");
      }
      role = newRole;
    }
    await db.query(
      "UPDATE family_member SET name = $1, life_stage = $2, diet = $3, allergies = $4, role = $5 WHERE id = $6",
      [name, lifeStage, diet, allergies, role, target.id],
    );
    return { body: toMember(await familyMember(db, self.family_id, target.id)) };
  });

  router.add("DELETE", "/api/family/members/:id", async (req) => {
    const { member: self } = await requireMember(db, req);
    const target = await familyMember(db, self.family_id, req.params.id);
    // Admins can remove anyone; anyone can leave.
    if (self.role !== "admin" && target.id !== self.id) throw new HttpError(403, "Only a Family Manager can remove members");
    if (target.role === "admin" && target.user_id && (await adminCount(db, self.family_id)) <= 1) {
      throw new HttpError(400, "A family needs at least one Family Manager; make someone else a Family Manager first");
    }
    await db.query("DELETE FROM family_member WHERE id = $1", [target.id]);
    return { status: 204 };
  });

  // --- invites ----------------------------------------------------------

  router.add("GET", "/api/family/invites", async (req) => {
    const { member } = await requireAdmin(db, req);
    const { rows } = await db.query<InviteRow>(
      `SELECT i.id, i.code, i.member_id, m.name AS member_name, i.created_at, i.expires_at
         FROM invite i LEFT JOIN family_member m ON m.id = i.member_id
        WHERE i.family_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
      [member.family_id],
    );
    const body: Invite[] = rows.map(toInvite);
    return { body };
  });

  router.add("POST", "/api/family/invites", async (req) => {
    const { member } = await requireAdmin(db, req);
    const b = req.body === undefined ? {} : v.object(req.body);
    let target: MemberRow | null = null;
    if (b.memberId !== undefined && b.memberId !== null) {
      target = await familyMember(db, member.family_id, String(b.memberId));
      if (target.user_id) throw new HttpError(400, `${target.name} already has their own login`);
      if (!canSignIn(target.life_stage)) throw new HttpError(400, "Only adults and teenagers can be invited to sign in");
    }
    const { rows } = await db.query<InviteRow>(
      `INSERT INTO invite (family_id, code, created_by, member_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
       RETURNING id, code, member_id, NULL::text AS member_name, created_at, expires_at`,
      [member.family_id, newInviteCode(), member.id, target?.id ?? null, INVITE_DAYS],
    );
    const body = toInvite({ ...rows[0], member_name: target?.name ?? null });
    return { status: 201, body };
  });

  router.add("DELETE", "/api/family/invites/:id", async (req) => {
    const { member } = await requireAdmin(db, req);
    const { rowCount } = await db.query("DELETE FROM invite WHERE id = $1 AND family_id = $2 AND accepted_at IS NULL", [
      v.uuid(req.params.id),
      member.family_id,
    ]);
    if (!rowCount) throw new HttpError(404, "That invite doesn't exist");
    return { status: 204 };
  });

  // Public: shown on the join page before the invitee signs up.
  router.add("GET", "/api/invites/:code", async (req) => {
    const { rows } = await db.query<{
      family_name: string;
      invited_by: string | null;
      member_name: string | null;
      expires_at: Date;
      accepted_at: Date | null;
    }>(
      `SELECT f.name AS family_name, m.name AS invited_by, t.name AS member_name, i.expires_at, i.accepted_at
         FROM invite i JOIN family f ON f.id = i.family_id
         LEFT JOIN family_member m ON m.id = i.created_by
         LEFT JOIN family_member t ON t.id = i.member_id
        WHERE i.code = $1`,
      [req.params.code.trim().toUpperCase()],
    );
    const r = rows[0];
    if (!r) throw new HttpError(404, "That invite link isn't valid");
    if (r.accepted_at) throw new HttpError(410, "That invite link has already been used");
    if (r.expires_at <= new Date()) throw new HttpError(410, "That invite link has expired, ask for a new one");
    const body: InvitePreview = {
      familyName: r.family_name,
      memberName: r.member_name,
      invitedBy: r.invited_by ?? "A family member",
      expiresAt: r.expires_at.toISOString(),
    };
    return { body };
  });

  // For a signed-in user who isn't in a family yet.
  router.add("POST", "/api/invites/:code/accept", async (req) => {
    const { userId, email } = await requireUser(db, req);
    const profile = profileFrom(req.body === undefined ? {} : v.object(req.body));
    await withTransaction(db, async (tx) => {
      try {
        await acceptInvite(tx, req.params.code, userId, profile);
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "You're already part of a family");
        throw err;
      }
    });
    return { body: await me(userId, email) };
  });

  // --- favourite recipes --------------------------------------------------
  // They belong to the family: anyone in it can add, remove or rate one.

  router.add("GET", "/api/family/recipes", async (req) => {
    const { member } = await requireMember(db, req);
    const { rows } = await db.query<RecipeRow>(`${recipeSelect("$2")} WHERE r.family_id = $1 ORDER BY r.created_at DESC`, [
      member.family_id,
      member.id,
    ]);
    const body: FavouriteRecipe[] = rows.map(toRecipe);
    return { body };
  });

  // Reads a recipe page so the person adding it can check (or fill in) the details before saving.
  router.add("POST", "/api/family/recipes/preview", async (req) => {
    const { member } = await requireMember(db, req);
    const url = v.webUrl(v.object(req.body).url, "Recipe link");
    const alreadySaved = !!(
      await db.query("SELECT 1 FROM favourite_recipe WHERE family_id = $1 AND url = $2", [member.family_id, url])
    ).rowCount;
    const preview: RecipePreview = {
      url,
      isRecipe: null,
      name: null,
      description: null,
      cookingMinutes: null,
      mainProtein: null,
      imageUrl: null,
      siteName: null,
      alreadySaved,
    };
    if (alreadySaved) return { body: preview };

    let page;
    try {
      page = await (options.fetchPage ?? fetchPage)(url);
    } catch {
      return { body: preview }; // Couldn't read it (offline, blocked, not HTML…): they fill it in.
    }
    const meta = parseRecipeMeta(page.html, page.url);
    Object.assign(preview, { name: meta.title, imageUrl: meta.imageUrl, siteName: meta.siteName });
    if (!options.readRecipe) return { body: preview };
    try {
      const images = pageImages(page.html, page.url);
      const details = await options.readRecipe({ url: page.url, text: pageText(page.html), images });
      // The page's own share image wins; otherwise Claude's pick, as long as it really is on the page.
      if (!preview.imageUrl && images.some((i) => i.url === details.imageUrl)) preview.imageUrl = details.imageUrl;
      preview.isRecipe = details.isRecipe;
      // Not a recipe: the page's title is no guess at a dish name, so leave it for the person to type.
      if (!details.isRecipe) preview.name = null;
      else {
        preview.name = details.name?.trim() || meta.title;
        preview.description = details.description?.trim() || null;
        const minutes = Math.round(details.cookingMinutes ?? 0);
        preview.cookingMinutes = minutes > 0 && minutes <= 2880 ? minutes : null;
        preview.mainProtein = details.mainProtein?.trim() || null;
      }
    } catch (err) {
      console.error("Reading a recipe with the LLM failed", err);
    }
    return { body: preview };
  });

  router.add("POST", "/api/family/recipes", async (req) => {
    const { member } = await requireMember(db, req);
    const b = v.object(req.body);
    const url = v.webUrl(b.url, "Recipe link");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO favourite_recipe (family_id, url, name, description, cooking_minutes, main_protein, image_url, site_name, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (family_id, url) DO NOTHING RETURNING id`,
      [
        member.family_id,
        url,
        v.text(b.name, "Recipe name", 200),
        v.optionalText(b.description, "Description", 1000),
        v.optionalMinutes(b.cookingMinutes),
        v.optionalText(b.mainProtein, "Main protein", 80),
        b.imageUrl == null || b.imageUrl === "" ? null : v.webUrl(b.imageUrl, "Image link"),
        v.optionalText(b.siteName, "Site name", 80),
        member.id,
      ],
    );
    if (!rows[0]) throw new HttpError(409, "That recipe is already one of your favourites");
    const saved = (await db.query<RecipeRow>(`${recipeSelect("$2")} WHERE r.id = $1`, [rows[0].id, member.id])).rows[0];
    return { status: 201, body: toRecipe(saved) };
  });

  // Marking a recipe as prepared is for Family Managers only.
  router.add("PATCH", "/api/family/recipes/:id", async (req) => {
    const { member } = await requireAdmin(db, req);
    const prepared = v.object(req.body).prepared;
    if (typeof prepared !== "boolean") throw new HttpError(400, "Prepared must be true or false");
    const { rows } = await db.query<{ id: string }>(
      "UPDATE favourite_recipe SET prepared = $1 WHERE id = $2 AND family_id = $3 RETURNING id",
      [prepared, v.uuid(req.params.id), member.family_id],
    );
    if (!rows[0]) throw new HttpError(404, "That recipe isn't in your favourites");
    const updated = (await db.query<RecipeRow>(`${recipeSelect("$2")} WHERE r.id = $1`, [rows[0].id, member.id])).rows[0];
    return { body: toRecipe(updated) };
  });

  // Anyone in the family can rate a recipe; 0 stars clears their rating.
  router.add("PUT", "/api/family/recipes/:id/rating", async (req) => {
    const { member } = await requireMember(db, req);
    const stars = v.stars(v.object(req.body).stars);
    const id = v.uuid(req.params.id);
    const found = await db.query("SELECT 1 FROM favourite_recipe WHERE id = $1 AND family_id = $2", [id, member.family_id]);
    if (!found.rowCount) throw new HttpError(404, "That recipe isn't in your favourites");
    if (stars === 0) {
      await db.query("DELETE FROM recipe_rating WHERE recipe_id = $1 AND member_id = $2", [id, member.id]);
    } else {
      await db.query(
        `INSERT INTO recipe_rating (recipe_id, member_id, stars) VALUES ($1, $2, $3)
         ON CONFLICT (recipe_id, member_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
        [id, member.id, stars],
      );
    }
    const updated = (await db.query<RecipeRow>(`${recipeSelect("$2")} WHERE r.id = $1`, [id, member.id])).rows[0];
    return { body: toRecipe(updated) };
  });

  router.add("DELETE", "/api/family/recipes/:id", async (req) => {
    const { member } = await requireMember(db, req);
    const { rowCount } = await db.query("DELETE FROM favourite_recipe WHERE id = $1 AND family_id = $2", [
      v.uuid(req.params.id),
      member.family_id,
    ]);
    if (!rowCount) throw new HttpError(404, "That recipe isn't in your favourites");
    return { status: 204 };
  });

  // --- restaurants --------------------------------------------------------

  /** Where the address suggestion someone picked is. */
  const pickedPlace = async (r: RestaurantInput): Promise<FoundPlace | null> => {
    if (!r.picked) return null;
    const { placeId, sessionToken } = r.picked;
    const place = await searching(() => requireAddressSearch().place(placeId, sessionToken));
    if (!place) throw new HttpError(400, "Choose an address from the list, or type it in");
    return place;
  };

  // Suggestions as someone types a restaurant's address (or its name), nearest home first.
  router.add("POST", "/api/family/restaurants/address/search", async (req) => {
    const { member } = await requireMember(db, req);
    const search = requireAddressSearch();
    const b = v.object(req.body);
    const input = v.text(b.input, "Address", 200);
    const token = sessionToken(b.sessionToken);
    const near = await homeLocation(db, undefined, member.family_id);
    const body: AddressSearchResponse = { suggestions: await searching(() => search.suggestPlaces(input, token, near)) };
    return { body };
  });
  // Like recipes, they belong to the family: anyone in it can add, edit or remove one.

  router.add("GET", "/api/family/restaurants", async (req) => {
    const { member } = await requireMember(db, req);
    const { rows } = await db.query<RestaurantRow>(`${restaurantSelect("$2")} WHERE r.family_id = $1 ORDER BY lower(r.name)`, [
      member.family_id,
      member.id,
    ]);
    const body: Restaurant[] = rows.map(toRestaurant);
    return { body };
  });

  // Adding one (or changing its name or address) also finds it on the map and times the drive from home.
  router.add("POST", "/api/family/restaurants", async (req) => {
    const { member } = await requireMember(db, req);
    const typed = restaurantInput(req.body);
    const taken = await db.query("SELECT 1 FROM restaurant WHERE family_id = $1 AND lower(name) = lower($2)", [member.family_id, typed.name]);
    if (taken.rowCount) throw new HttpError(409, `${typed.name} is already one of your restaurants`);
    const picked = await pickedPlace(typed);
    const r = await fillFromPage(options, typed);
    const at = await locateRestaurant(options.maps, await homeLocation(db, options.maps, member.family_id), r, picked);
    let id: string;
    try {
      id = (
        await db.query<{ id: string }>(
          `INSERT INTO restaurant (family_id, name, url, notes, address, latitude, longitude, drive_minutes, cuisine, booking_url, added_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [member.family_id, r.name, r.url, r.notes, at.address, at.latitude, at.longitude, at.drive_minutes, r.cuisine, r.bookingUrl, member.id],
        )
      ).rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, `${r.name} is already one of your restaurants`);
      throw err;
    }
    const saved = (await db.query<RestaurantRow>(`${restaurantSelect("$2")} WHERE r.id = $1`, [id, member.id])).rows[0];
    return { status: 201, body: toRestaurant(saved) };
  });

  router.add("PUT", "/api/family/restaurants/:id", async (req) => {
    const { member } = await requireMember(db, req);
    const id = v.uuid(req.params.id);
    const typed = restaurantInput(req.body);
    const current = (
      await db.query<RestaurantRow & RestaurantLocation>("SELECT * FROM restaurant WHERE id = $1 AND family_id = $2", [id, member.family_id])
    ).rows[0];
    if (!current) throw new HttpError(404, "That restaurant isn't in your list");
    // A new link is read again for anything left blank.
    const r = typed.url !== current.url ? await fillFromPage(options, typed) : typed;
    // Only look it up again when where it is may have changed. A blank address means "find it by name".
    const typedAddressKept = r.address !== null && r.address === current.address && current.latitude !== null;
    const foundByNameKept = r.address === null && r.name === current.name && current.latitude !== null;
    const picked = await pickedPlace(typed);
    const at: RestaurantLocation =
      !picked && (typedAddressKept || foundByNameKept)
        ? current
        : await locateRestaurant(options.maps, await homeLocation(db, options.maps, member.family_id), r, picked);
    let updated;
    try {
      updated = await db.query(
        `UPDATE restaurant SET name = $1, url = $2, notes = $3, address = $4, latitude = $5, longitude = $6, drive_minutes = $7,
           cuisine = $8, booking_url = $9
         WHERE id = $10 AND family_id = $11`,
        [r.name, r.url, r.notes, at.address, at.latitude, at.longitude, at.drive_minutes, r.cuisine, r.bookingUrl, id, member.family_id],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, `${r.name} is already one of your restaurants`);
      throw err;
    }
    if (!updated.rowCount) throw new HttpError(404, "That restaurant isn't in your list");
    const saved = (await db.query<RestaurantRow>(`${restaurantSelect("$2")} WHERE r.id = $1`, [id, member.id])).rows[0];
    return { body: toRestaurant(saved) };
  });

  // Anyone in the family can rate a restaurant; 0 stars clears their rating.
  router.add("PUT", "/api/family/restaurants/:id/rating", async (req) => {
    const { member } = await requireMember(db, req);
    const stars = v.stars(v.object(req.body).stars);
    const id = v.uuid(req.params.id);
    const found = await db.query("SELECT 1 FROM restaurant WHERE id = $1 AND family_id = $2", [id, member.family_id]);
    if (!found.rowCount) throw new HttpError(404, "That restaurant isn't in your list");
    if (stars === 0) {
      await db.query("DELETE FROM restaurant_rating WHERE restaurant_id = $1 AND member_id = $2", [id, member.id]);
    } else {
      await db.query(
        `INSERT INTO restaurant_rating (restaurant_id, member_id, stars) VALUES ($1, $2, $3)
         ON CONFLICT (restaurant_id, member_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
        [id, member.id, stars],
      );
    }
    const updated = (await db.query<RestaurantRow>(`${restaurantSelect("$2")} WHERE r.id = $1`, [id, member.id])).rows[0];
    return { body: toRestaurant(updated) };
  });

  router.add("DELETE", "/api/family/restaurants/:id", async (req) => {
    const { member } = await requireMember(db, req);
    const { rowCount } = await db.query("DELETE FROM restaurant WHERE id = $1 AND family_id = $2", [
      v.uuid(req.params.id),
      member.family_id,
    ]);
    if (!rowCount) throw new HttpError(404, "That restaurant isn't in your list");
    return { status: 204 };
  });

  // --- weekly schedule ----------------------------------------------------
  // Weeks run Monday to Sunday. Like recipes, the schedule belongs to the family: anyone in it can change it.

  router.add("GET", "/api/family/weeks", async (req) => {
    const { member } = await requireMember(db, req);
    return { body: await loadWeeks(db, member.family_id) };
  });

  // Adds this week, if the family doesn't have it yet, or else the week after their last one.
  router.add("POST", "/api/family/weeks", async (req) => {
    const { member } = await requireMember(db, req);
    const b = v.object(req.body);
    const startsOn = v.isoDate(b.startsOn, "Week");
    if (mondayOf(startsOn) !== startsOn) throw new HttpError(400, "A week starts on a Monday");
    // The person's own date decides which week is "this week", within a day of ours (time zones).
    const today = v.isoDate(b.today, "Today");
    const serverToday = new Date().toISOString().slice(0, 10);
    if (today < addDays(serverToday, -1) || today > addDays(serverToday, 1)) {
      throw new HttpError(400, "Your device's date looks wrong; check it and try again");
    }

    const familyIds = await familyMemberIds(db, member.family_id);
    // This week starts from today: days already gone aren't planned.
    const days = daysToPlan(startsOn, today).map((date): ScheduleDay => ({ date, eatOut: false, memberIds: familyIds, guests: 0 }));
    // When days are listed, only those days are planned (the rest are left out of the schedule).
    if (b.days !== undefined) {
      if (!Array.isArray(b.days)) throw new HttpError(400, "Days must be a list");
      const planned = new Map<string, ScheduleDay>();
      for (const raw of b.days) {
        const d = v.object(raw);
        const date = v.isoDate(d.date, "Day");
        if (!days.some((day) => day.date === date)) {
          if (weekDays(startsOn).includes(date)) throw new HttpError(400, `${date} has already passed`);
          throw new HttpError(400, `${date} isn't in the week starting ${startsOn}`);
        }
        if (planned.has(date)) throw new HttpError(400, `${date} is listed twice`);
        planned.set(date, { date, ...dinner(d, familyIds) });
      }
      days.splice(0, days.length, ...days.filter((d) => planned.has(d.date)).map((d) => planned.get(d.date)!));
    }
    if (days.length === 0) throw new HttpError(400, "Plan at least one day");

    await withTransaction(db, async (tx) => {
      // One week added at a time per family, so two people can't both add "next week".
      await tx.query("SELECT 1 FROM family WHERE id = $1 FOR UPDATE", [member.family_id]);
      const existing = (
        await tx.query<{ starts_on: string }>(
          "SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM schedule_week WHERE family_id = $1",
          [member.family_id],
        )
      ).rows.map((r) => r.starts_on);
      if (existing.includes(startsOn)) throw new HttpError(409, "That week is already in your schedule");
      const allowed = nextWeekToAdd(existing, today);
      if (startsOn !== allowed) throw new HttpError(409, `The next week you can add starts on ${allowed}`);
      const weekId = (
        await tx.query<{ id: string }>(
          "INSERT INTO schedule_week (family_id, starts_on, created_by) VALUES ($1, $2, $3) RETURNING id",
          [member.family_id, startsOn, member.id],
        )
      ).rows[0].id;
      for (const day of days) await saveDay(tx, weekId, day);
    });
    return { status: 201, body: (await loadWeeks(db, member.family_id, startsOn))[0] };
  });

  router.add("PATCH", "/api/family/weeks/:startsOn/days/:date", async (req) => {
    const { member } = await requireMember(db, req);
    const startsOn = weekStart(req.params.startsOn);
    const date = req.params.date;
    if (!weekDays(startsOn).includes(date)) throw new HttpError(404, "That day isn't in this week");
    const day: ScheduleDay = { date, ...dinner(v.object(req.body), await familyMemberIds(db, member.family_id)) };
    await withTransaction(db, async (tx) => {
      const week = (
        await tx.query<{ id: string }>("SELECT id FROM schedule_week WHERE family_id = $1 AND starts_on = $2", [member.family_id, startsOn])
      ).rows[0];
      if (!week) throw new HttpError(404, "That week isn't in your schedule");
      // A day that isn't in the schedule (removed, or before the week was added) can be added back until it has passed.
      const exists = (await tx.query("SELECT 1 FROM schedule_day WHERE week_id = $1 AND day = $2", [week.id, date])).rowCount;
      if (!exists && date < addDays(new Date().toISOString().slice(0, 10), -1)) throw new HttpError(404, "That day has already passed");
      await saveDay(tx, week.id, day);
    });
    const body: ScheduleDay = (await loadWeeks(db, member.family_id, startsOn))[0].days.find((d) => d.date === date)!;
    return { body };
  });

  // Takes a day out of the schedule altogether (e.g. everyone's away).
  router.add("DELETE", "/api/family/weeks/:startsOn/days/:date", async (req) => {
    const { member } = await requireMember(db, req);
    const startsOn = weekStart(req.params.startsOn);
    await withTransaction(db, async (tx) => {
      const week = (
        await tx.query<{ id: string }>("SELECT id FROM schedule_week WHERE family_id = $1 AND starts_on = $2 FOR UPDATE", [
          member.family_id,
          startsOn,
        ])
      ).rows[0];
      if (!week) throw new HttpError(404, "That week isn't in your schedule");
      const { rows } = await tx.query<{ day: string }>("SELECT to_char(day, 'YYYY-MM-DD') AS day FROM schedule_day WHERE week_id = $1", [
        week.id,
      ]);
      if (!rows.some((r) => r.day === req.params.date)) throw new HttpError(404, "That day isn't in this week");
      if (rows.length === 1) throw new HttpError(400, "That's the week's only day; remove the week instead");
      await tx.query("DELETE FROM schedule_day WHERE week_id = $1 AND day = $2", [week.id, req.params.date]);
    });
    return { status: 204 };
  });

  router.add("DELETE", "/api/family/weeks/:startsOn", async (req) => {
    const { member } = await requireMember(db, req);
    const { rowCount } = await db.query("DELETE FROM schedule_week WHERE family_id = $1 AND starts_on = $2", [
      member.family_id,
      weekStart(req.params.startsOn),
    ]);
    if (!rowCount) throw new HttpError(404, "That week isn't in your schedule");
    return { status: 204 };
  });

  return router;
}

export function createApp(db: Db, options: AppOptions): Server {
  return createServer(listener(buildRouter(db, options), options.webOrigins));
}
