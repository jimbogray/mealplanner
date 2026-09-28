import { createServer, type Server } from "node:http";
import {
  addDays,
  canSignIn,
  daysToPlan,
  displayName,
  eventOn,
  isIsoDate,
  isoWeekday,
  isTimeOfDay,
  MAX_EVENT_TITLE,
  MAX_MEAL_NAME,
  mondayOf,
  nextWeekToAdd,
  type Address,
  type AddressSearchResponse,
  type Aisle,
  AISLES,
  type FamilyPreferences,
  ingredientKey,
  shoppingItems,
  groceryAisle,
  MAX_EXTRA_NAME,
  type Quantity,
  type ShoppingExtra,
  type ShoppingList,
  type ShoppingMeal,
  weekDays,
  type AuthResponse,
  type Family,
  type FamilyMember,
  type FavouriteRecipe,
  type Invite,
  type InvitePreview,
  type LifeStage,
  type Me,
  type MealSuggestion,
  type RecipePreview,
  type Restaurant,
  type RestaurantPreview,
  type ScheduleDay,
  type ScheduleEvent,
  type ScheduleMeal,
  type ScheduleWeek,
} from "@mealplanner/shared";
import { AddressSearchError, type AddressSearch, type FoundPlace } from "./places.js";
import { createSession, hashPassword, hashToken, bearerToken, newInviteCode, requireUser, verifyPassword } from "./auth.js";
import { withTransaction, type Db, type Tx } from "./db.js";
import { GoogleTokenError, verifyGoogleIdToken, type GoogleIdentity, type KeySource } from "./google.js";
import { HttpError, listener, Router, type Request } from "./http.js";
import { fetchPage, pageImages, pageLinks, pageText, parseRecipeMeta, type PageFetcher } from "./recipe-meta.js";
import type { IngredientReader, RecipeIngredients } from "./ingredient-reader.js";
import type { Maps } from "./maps.js";
import type { MealSuggester, SuggestBrief } from "./meal-suggester.js";
import type { RecipeReader } from "./recipe-reader.js";
import type { RestaurantReader } from "./restaurant-reader.js";
import * as v from "./validate.js";

export const INVITE_DAYS = 14;

/** Request header a Family Manager sets to a member id to act as that member (lower case, as node gives it). */
export const ACT_AS_HEADER = "x-act-as";

type Queryable = Pick<Db, "query">;

interface MemberRow {
  id: string;
  family_id: string;
  user_id: string | null;
  name: string;
  familiar_name: string | null;
  life_stage: FamilyMember["lifeStage"];
  diet: FamilyMember["diet"];
  allergies: FamilyMember["allergies"];
  role: FamilyMember["role"];
  wfh_days: number[];
  email: string | null;
  created_at: Date;
}

const MEMBER_SELECT = `SELECT m.id, m.family_id, m.user_id, m.name, m.familiar_name, m.life_stage, m.diet, m.allergies, m.role, m.wfh_days, u.email, m.created_at
  FROM family_member m LEFT JOIN app_user u ON u.id = m.user_id`;

function toMember(r: MemberRow): FamilyMember {
  return {
    id: r.id,
    name: r.name,
    familiarName: r.familiar_name,
    lifeStage: r.life_stage,
    diet: r.diet,
    allergies: r.allergies,
    role: r.role,
    workFromHomeDays: r.wfh_days,
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
  /** Postgres TIME, e.g. "18:30:00". */
  dinner_weekday: string | null;
  dinner_weekend: string | null;
  eat_outs_per_week: number;
  meal_kits_per_week: number;
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

type PreferenceColumns = "dinner_weekday" | "dinner_weekend" | "eat_outs_per_week" | "meal_kits_per_week";

function toPreferences(r: Pick<FamilyRow, PreferenceColumns>): FamilyPreferences {
  return {
    dinnerTimes: { weekday: r.dinner_weekday?.slice(0, 5) ?? null, weekend: r.dinner_weekend?.slice(0, 5) ?? null },
    eatOutsPerWeek: r.eat_outs_per_week,
    mealKitsPerWeek: r.meal_kits_per_week,
  };
}

async function loadMe(
  db: Queryable,
  userId: string,
  email: string,
  features: Pick<Me, "addressSearch" | "mealSuggestions">,
  req?: Request,
): Promise<Me> {
  const user = { id: userId, email };
  const self = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [userId])).rows[0];
  if (!self) return { user, family: null, member: null, signedInAs: null, members: [], ...features };
  const actor = req ? await actingAs(db, req, self) : self;
  const fam = (await db.query<FamilyRow>("SELECT * FROM family WHERE id = $1", [self.family_id])).rows[0];
  const members = (
    await db.query<MemberRow>(
      `${MEMBER_SELECT} WHERE m.family_id = $1
        ORDER BY array_position(ARRAY['adult','teenager','child','toddler','baby']::life_stage[], m.life_stage), m.created_at`,
      [self.family_id],
    )
  ).rows.map(toMember);
  const family: Family = { id: fam.id, name: fam.name, address: toAddress(fam), ...toPreferences(fam), createdAt: fam.created_at.toISOString() };
  return {
    user,
    family,
    member: toMember(actor),
    signedInAs: actor.id === self.id ? null : toMember(self),
    members,
    ...features,
  };
}

/**
 * The member the request acts as: a Family Manager can send ACT_AS_HEADER with another
 * member's id to use the app as them, with that member's permissions. Otherwise, themselves.
 */
async function actingAs(db: Queryable, req: Request, self: MemberRow): Promise<MemberRow> {
  const header = req.headers[ACT_AS_HEADER];
  const id = Array.isArray(header) ? header[0] : header;
  if (!id || id === self.id) return self;
  if (self.role !== "admin") throw new HttpError(403, "Only a Family Manager can switch to another family member");
  return familyMember(db, self.family_id, id);
}

/**
 * The member the request acts as (see actingAs), or 403 if the signed-in user isn't in a family.
 * `self` is always the signed-in user's own member row.
 */
async function requireMember(
  db: Db,
  req: Request,
): Promise<{ userId: string; email: string; member: MemberRow; self: MemberRow }> {
  const user = await requireUser(db, req);
  const self = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [user.userId])).rows[0];
  if (!self) throw new HttpError(403, "You're not part of a family yet");
  return { ...user, member: await actingAs(db, req, self), self };
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
  /** Reads a recipe's ingredients from its page with an LLM, for the shopping list. Without it, there's no shopping list. */
  readIngredients?: IngredientReader;
  /** Finds restaurants on the map and times the drive from home. Without it, there are no driving times. */
  maps?: Maps;
  /** Reads a restaurant's web page for its cuisine, address and booking link. Without it, people type them in. */
  readRestaurant?: RestaurantReader;
  /** Finds UK addresses as people type (Google Places). Without it, the home address can't be set. */
  addressSearch?: AddressSearch;
  /** Suggests a week's dinners with an LLM. Without it, there's no Suggest button. */
  suggestMeals?: MealSuggester;
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
  chosen_on: string[];
  added_by: string | null;
  created_at: Date;
}

/** The dates on the schedule a recipe or restaurant (`r`) is the meal for, oldest first. */
function chosenOn(column: "meal_recipe_id" | "meal_restaurant_id"): string {
  return `ARRAY(SELECT to_char(day, 'YYYY-MM-DD') FROM schedule_day WHERE ${column} = r.id ORDER BY day) AS chosen_on`;
}

/** Selects recipes with their ratings; `me` is the placeholder (e.g. "$2") for the caller's member id. */
function recipeSelect(me: string): string {
  return `SELECT r.id, r.url, r.name, r.description, r.cooking_minutes, r.main_protein, r.image_url, r.site_name,
    r.prepared, COALESCE(m.familiar_name, m.name) AS added_by, r.created_at,
    (SELECT round(avg(stars), 1) FROM recipe_rating WHERE recipe_id = r.id) AS average_rating,
    (SELECT count(*)::int FROM recipe_rating WHERE recipe_id = r.id) AS rating_count,
    (SELECT stars FROM recipe_rating WHERE recipe_id = r.id AND member_id = ${me}) AS my_rating,
    ${chosenOn("meal_recipe_id")}
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
    chosenOn: r.chosen_on,
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
  chosen_on: string[];
  added_by: string | null;
  created_at: Date;
}

/** Selects restaurants with their ratings; `me` is the placeholder (e.g. "$2") for the caller's member id. */
function restaurantSelect(me: string): string {
  return `SELECT r.id, r.name, r.url, r.notes, r.address, r.cuisine, r.booking_url, r.drive_minutes, COALESCE(m.familiar_name, m.name) AS added_by, r.created_at,
    (SELECT round(avg(stars), 1) FROM restaurant_rating WHERE restaurant_id = r.id) AS average_rating,
    (SELECT count(*)::int FROM restaurant_rating WHERE restaurant_id = r.id) AS rating_count,
    (SELECT stars FROM restaurant_rating WHERE restaurant_id = r.id AND member_id = ${me}) AS my_rating,
    ${chosenOn("meal_restaurant_id")}
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
    chosenOn: r.chosen_on,
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
  /** Empty only while adding one with a link, until it's read from the page. */
  name: string;
  url: string | null;
  notes: string | null;
  address: string | null;
  cuisine: string | null;
  bookingUrl: string | null;
  /** An address suggestion the person picked (see /api/family/restaurants/address/search). */
  picked: { placeId: string; sessionToken: string } | null;
  /** Whether to read the link for anything left blank; false after a preview, so what was checked is saved as is. */
  readLink: boolean;
}

function optionalWebUrl(value: unknown, field: string): string | null {
  return value == null || (typeof value === "string" && !value.trim()) ? null : v.webUrl(value, field);
}

/** A restaurant's details, as added or edited. When adding, the name may be left out if there's a link. */
function restaurantInput(body: unknown, adding = false): RestaurantInput {
  const b = v.object(body);
  const url = optionalWebUrl(b.url, "Restaurant link");
  const nameMissing = b.name == null || (typeof b.name === "string" && !b.name.trim());
  return {
    name: adding && url && nameMissing ? "" : v.text(b.name, "Restaurant name", 120),
    url,
    notes: v.optionalText(b.notes, "Notes", 1000),
    address: v.optionalText(b.address, "Address", 200),
    cuisine: v.optionalText(b.cuisine, "Cuisine", 60),
    bookingUrl: optionalWebUrl(b.bookingUrl, "Booking link"),
    picked: b.placeId == null ? null : { placeId: v.text(b.placeId, "Address", 1000), sessionToken: sessionToken(b.sessionToken) },
    readLink: b.readLink !== false,
  };
}

interface FoundRestaurant {
  name: string | null;
  cuisine: string | null;
  address: string | null;
  bookingUrl: string | null;
}

/** What Claude reads on a restaurant's web page; null if it can't be read or isn't a restaurant's. */
async function readRestaurantPage(options: Pick<AppOptions, "fetchPage" | "readRestaurant">, url: string): Promise<FoundRestaurant | null> {
  if (!options.readRestaurant) return null;
  try {
    const page = await (options.fetchPage ?? fetchPage)(url);
    const links = pageLinks(page.html, page.url);
    const found = await options.readRestaurant({ url: page.url, text: pageText(page.html), links });
    if (!found.isRestaurant) return null;
    // Only a link that's really on the page, so a made-up one can't slip through.
    const booking = links.find((l) => l.url === found.bookingUrl?.trim())?.url ?? null;
    return {
      name: found.name?.trim().slice(0, 120) || null,
      cuisine: found.cuisine?.trim().slice(0, 60) || null,
      address: found.address?.trim().slice(0, 200) || null,
      bookingUrl: booking,
    };
  } catch (err) {
    console.error("Reading a restaurant's page failed", err);
    return null;
  }
}

/**
 * Fills in whatever the person left blank (name, cuisine, address, booking link) from the restaurant's web page,
 * read by Claude. What they typed always wins; a page that can't be read, or isn't a restaurant's, changes nothing.
 */
async function fillFromPage(options: Pick<AppOptions, "fetchPage" | "readRestaurant">, r: RestaurantInput): Promise<RestaurantInput> {
  if (!r.url || !r.readLink || (r.name && r.cuisine && r.address && r.bookingUrl)) return r;
  const found = await readRestaurantPage(options, r.url);
  if (!found) return r;
  return {
    ...r,
    name: r.name || found.name || "",
    cuisine: r.cuisine ?? found.cuisine,
    address: r.address ?? found.address,
    bookingUrl: r.bookingUrl ?? found.bookingUrl,
  };
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
  wfh_ids: string[];
  meal_name: string | null;
  meal_recipe_id: string | null;
  meal_restaurant_id: string | null;
  meal_kit: boolean;
  meal_url: string | null;
}

/** The family's weeks (or just the one starting on `startsOn`), oldest first, each with its seven days. */
async function loadWeeks(db: Queryable, familyId: string, startsOn?: string): Promise<ScheduleWeek[]> {
  const { rows } = await db.query<ScheduleRow>(
    `SELECT w.id, to_char(w.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(d.day, 'YYYY-MM-DD') AS day, d.guests, d.eat_out,
            coalesce(array_agg(s.member_id::text ORDER BY s.member_id) FILTER (WHERE s.member_id IS NOT NULL), '{}') AS member_ids,
            ARRAY(SELECT h.member_id::text FROM schedule_wfh h WHERE h.week_id = w.id AND h.day = d.day ORDER BY h.member_id) AS wfh_ids,
            -- A linked recipe or restaurant shows its current name.
            coalesce(fr.name, rs.name, d.meal_name) AS meal_name, d.meal_recipe_id, d.meal_restaurant_id, d.meal_kit,
            coalesce(fr.url, rs.url) AS meal_url
       FROM schedule_week w
       JOIN schedule_day d ON d.week_id = w.id
       LEFT JOIN schedule_diner s ON s.week_id = d.week_id AND s.day = d.day
       LEFT JOIN favourite_recipe fr ON fr.id = d.meal_recipe_id
       LEFT JOIN restaurant rs ON rs.id = d.meal_restaurant_id
      WHERE w.family_id = $1 AND ($2::date IS NULL OR w.starts_on = $2::date)
      GROUP BY w.id, w.starts_on, d.day, d.guests, d.eat_out, d.meal_name, d.meal_recipe_id, d.meal_restaurant_id, d.meal_kit, fr.name, fr.url, rs.name, rs.url
      ORDER BY w.starts_on, d.day`,
    [familyId, startsOn ?? null],
  );
  const weeks: ScheduleWeek[] = [];
  for (const r of rows) {
    if (weeks.at(-1)?.id !== r.id) weeks.push({ id: r.id, startsOn: r.starts_on, days: [] });
    const meal: ScheduleMeal | null =
      r.meal_name || r.meal_kit
        ? { name: r.meal_name ?? "", mealKit: r.meal_kit, recipeId: r.meal_recipe_id, restaurantId: r.meal_restaurant_id, url: r.meal_url }
      : null;
    weeks.at(-1)!.days.push({ date: r.day, eatOut: r.eat_out, memberIds: r.member_ids, guests: r.guests, meal, workingFromHomeIds: r.wfh_ids });
  }
  return weeks;
}

interface EventRow {
  id: string;
  title: string;
  day: string;
  starts_at: string;
  ends_at: string;
  weekly: boolean;
  until: string | null;
  member_ids: string[];
}

/** The family's events (or just one), in date then time order. */
async function loadEvents(db: Queryable, familyId: string, id?: string): Promise<ScheduleEvent[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT e.id, e.title, to_char(e.day, 'YYYY-MM-DD') AS day, to_char(e.starts_at, 'HH24:MI') AS starts_at,
            to_char(e.ends_at, 'HH24:MI') AS ends_at, e.weekly, to_char(e.until, 'YYYY-MM-DD') AS until,
            ARRAY(SELECT member_id::text FROM schedule_event_member WHERE event_id = e.id ORDER BY member_id) AS member_ids
       FROM schedule_event e
      WHERE e.family_id = $1 AND ($2::uuid IS NULL OR e.id = $2::uuid)
      ORDER BY e.day, e.starts_at, e.created_at`,
    [familyId, id ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    date: r.day,
    startTime: r.starts_at,
    endTime: r.ends_at,
    memberIds: r.member_ids,
    weekly: r.weekly,
    until: r.until,
  }));
}

/** An event as sent in, checked against the family's members; `base` fills in anything left out (PATCH). */
function eventFrom(b: Record<string, unknown>, familyIds: string[], base?: ScheduleEvent): Omit<ScheduleEvent, "id"> {
  const pick = <K extends keyof ScheduleEvent>(k: K): unknown => (b[k] === undefined && base ? base[k] : b[k]);
  const title = v.text(pick("title"), "Event", MAX_EVENT_TITLE);
  const date = v.isoDate(pick("date"), "Day");
  const startTime = pick("startTime");
  const endTime = pick("endTime");
  if (!isTimeOfDay(startTime)) throw new HttpError(400, "Start time must be a time like 17:30");
  if (!isTimeOfDay(endTime)) throw new HttpError(400, "End time must be a time like 18:45");
  if (endTime <= startTime) throw new HttpError(400, "An event has to end after it starts");
  const memberIds = v.ids(pick("memberIds"), "Who's going");
  if (!memberIds.length) throw new HttpError(400, "Choose who's going");
  if (memberIds.some((id) => !familyIds.includes(id))) throw new HttpError(400, "Only members of your family can go");
  const weekly = pick("weekly") ?? false;
  if (typeof weekly !== "boolean") throw new HttpError(400, "Weekly must be true or false");
  const rawUntil = pick("until");
  const until = weekly && rawUntil !== undefined && rawUntil !== null ? v.isoDate(rawUntil, "Until") : null;
  if (until !== null && until < date) throw new HttpError(400, "A weekly event can't stop before it starts");
  return { title, date, startTime, endTime, memberIds, weekly, until };
}

async function saveEventMembers(tx: Tx, eventId: string, memberIds: string[]): Promise<void> {
  await tx.query("DELETE FROM schedule_event_member WHERE event_id = $1", [eventId]);
  await tx.query("INSERT INTO schedule_event_member (event_id, member_id) SELECT $1, unnest($2::uuid[])", [eventId, memberIds]);
}

/** Who's working from home in a day's request (adults in the family only); undefined when it's left out. */
async function workingFromHome(db: Queryable, b: Record<string, unknown>, familyId: string): Promise<string[] | undefined> {
  if (b.workingFromHomeIds === undefined) return undefined;
  const ids = v.ids(b.workingFromHomeIds, "Working from home");
  const { rows } = await db.query<{ id: string }>("SELECT id FROM family_member WHERE family_id = $1 AND life_stage = 'adult'", [familyId]);
  if (ids.some((id) => !rows.some((r) => r.id === id))) throw new HttpError(400, "Only adults in your family can be working from home");
  return ids;
}

async function familyMemberIds(db: Queryable, familyId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM family_member WHERE family_id = $1 ORDER BY created_at", [familyId]);
  return rows.map((r) => r.id);
}

/** A day as sent in: who's joining and guests, plus the meal (undefined = leave it as it is). */
type DayInput = Omit<ScheduleDay, "meal" | "workingFromHomeIds"> & { meal?: MealRow | null; workingFromHomeIds?: string[] };

/** A chosen meal as stored. */
interface MealRow {
  /** null only for a meal kit that doesn't say which one. */
  name: string | null;
  mealKit: boolean;
  recipeId: string | null;
  restaurantId: string | null;
}

/** Who's joining and how many guests, checked against the family's members. Eating out clears both. */
function dinner(b: Record<string, unknown>, familyIds: string[]): Omit<ScheduleDay, "date" | "meal" | "workingFromHomeIds"> {
  if (b.eatOut !== undefined && typeof b.eatOut !== "boolean") throw new HttpError(400, "Eat out must be true or false");
  if (b.eatOut) return { eatOut: true, memberIds: [], guests: 0 };
  const memberIds = v.ids(b.memberIds, "Who's joining");
  if (memberIds.some((id) => !familyIds.includes(id))) throw new HttpError(400, "Only members of your family can join for dinner");
  return { eatOut: false, memberIds, guests: v.guests(b.guests) };
}

/**
 * The meal in a day's request (Family Managers only), checked against the family's recipes and restaurants.
 * undefined when the request leaves the meal out.
 */
async function mealFrom(db: Queryable, b: Record<string, unknown>, member: MemberRow, eatOut: boolean): Promise<MealRow | null | undefined> {
  if (b.meal === undefined) return undefined;
  if (member.role !== "admin") throw new HttpError(403, "Only a Family Manager can choose meals");
  if (b.meal === null) return null;
  const m = v.object(b.meal);
  if (m.recipeId !== undefined) {
    if (eatOut) throw new HttpError(400, "A recipe is for eating in; pick a restaurant for eating out");
    const r = (
      await db.query<{ id: string; name: string }>("SELECT id, name FROM favourite_recipe WHERE id = $1 AND family_id = $2", [
        v.uuid(String(m.recipeId)),
        member.family_id,
      ])
    ).rows[0];
    if (!r) throw new HttpError(400, "That recipe isn't in your family's recipes");
    return { name: r.name, mealKit: false, recipeId: r.id, restaurantId: null };
  }
  if (m.restaurantId !== undefined) {
    if (!eatOut) throw new HttpError(400, "A restaurant is for eating out; mark the day as eating out first");
    const r = (
      await db.query<{ id: string; name: string }>("SELECT id, name FROM restaurant WHERE id = $1 AND family_id = $2", [
        v.uuid(String(m.restaurantId)),
        member.family_id,
      ])
    ).rows[0];
    if (!r) throw new HttpError(400, "That restaurant isn't in your family's restaurants");
    return { name: r.name, mealKit: false, recipeId: null, restaurantId: r.id };
  }
  if (m.mealKit !== undefined && typeof m.mealKit !== "boolean") throw new HttpError(400, "Meal kit must be true or false");
  if (m.mealKit) {
    if (eatOut) throw new HttpError(400, "A meal kit is for eating in");
    const name = m.name === undefined || m.name === null || (typeof m.name === "string" && !m.name.trim()) ? null : v.text(m.name, "Meal kit", MAX_MEAL_NAME);
    return { name, mealKit: true, recipeId: null, restaurantId: null };
  }
  return { name: v.text(m.name, "Meal", MAX_MEAL_NAME), mealKit: false, recipeId: null, restaurantId: null };
}

/** When the family has dinner, if they haven't said. */
const DEFAULT_DINNER_TIME = "18:00";

/** A day's meal as it stands in the week form, described for the meal suggester; null when there isn't one. */
function chosenMeal(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const m = v.object(value);
  const name = typeof m.name === "string" ? m.name.trim().slice(0, MAX_MEAL_NAME) : "";
  if (m.mealKit === true) return name ? `Meal kit: ${name}` : "Meal kit";
  if (!name) return null;
  if (typeof m.recipeId === "string") return `Recipe: ${name}`;
  if (typeof m.restaurantId === "string") return `Restaurant: ${name}`;
  return name;
}

async function saveDay(tx: Tx, weekId: string, day: DayInput): Promise<void> {
  const meal = day.meal ?? null;
  // Without a meal in the request, the day keeps its meal, unless eating in or out changed (a recipe or
  // restaurant no longer fits).
  await tx.query(
    `INSERT INTO schedule_day (week_id, day, guests, eat_out, meal_name, meal_recipe_id, meal_restaurant_id, meal_kit)
     VALUES ($1, $2, $3, $4, $6, $7, $8, $9)
     ON CONFLICT (week_id, day) DO UPDATE SET guests = EXCLUDED.guests, eat_out = EXCLUDED.eat_out,
       meal_name = CASE WHEN $5 THEN EXCLUDED.meal_name WHEN schedule_day.eat_out <> EXCLUDED.eat_out THEN NULL ELSE schedule_day.meal_name END,
       meal_recipe_id = CASE WHEN $5 THEN EXCLUDED.meal_recipe_id WHEN schedule_day.eat_out <> EXCLUDED.eat_out THEN NULL ELSE schedule_day.meal_recipe_id END,
       meal_restaurant_id = CASE WHEN $5 THEN EXCLUDED.meal_restaurant_id WHEN schedule_day.eat_out <> EXCLUDED.eat_out THEN NULL ELSE schedule_day.meal_restaurant_id END,
       meal_kit = CASE WHEN $5 THEN EXCLUDED.meal_kit WHEN schedule_day.eat_out <> EXCLUDED.eat_out THEN false ELSE schedule_day.meal_kit END`,
    [weekId, day.date, day.guests, day.eatOut, day.meal !== undefined, meal?.name ?? null, meal?.recipeId ?? null, meal?.restaurantId ?? null, meal?.mealKit ?? false],
  );
  await tx.query("DELETE FROM schedule_diner WHERE week_id = $1 AND day = $2", [weekId, day.date]);
  await tx.query(
    "INSERT INTO schedule_diner (week_id, day, member_id) SELECT $1, $2, unnest($3::uuid[])",
    [weekId, day.date, day.memberIds],
  );
  if (day.workingFromHomeIds !== undefined) {
    await tx.query("DELETE FROM schedule_wfh WHERE week_id = $1 AND day = $2", [weekId, day.date]);
    await tx.query("INSERT INTO schedule_wfh (week_id, day, member_id) SELECT $1, $2, unnest($3::uuid[])", [
      weekId,
      day.date,
      day.workingFromHomeIds,
    ]);
  }
}

/** A Monday from the path, or 404. */
function weekStart(value: string): string {
  if (!isIsoDate(value) || mondayOf(value) !== value) throw new HttpError(404, "That week isn't in your schedule");
  return value;
}

/** A week in the path, as its id, or 404. */
async function weekId(db: Queryable, familyId: string, startsOn: string): Promise<string> {
  const week = (
    await db.query<{ id: string }>("SELECT id FROM schedule_week WHERE family_id = $1 AND starts_on = $2", [familyId, weekStart(startsOn)])
  ).rows[0];
  if (!week) throw new HttpError(404, "That week isn't in your schedule");
  return week.id;
}

const MAX_INGREDIENTS = 60;

/** What Claude read, tidied: names and amounts trimmed and capped, each ingredient once. */
function tidyIngredients(found: RecipeIngredients): { name: string; quantity: string | null; aisle: Aisle }[] {
  if (!found.isRecipe) return [];
  const seen = new Set<string>();
  const list: { name: string; quantity: string | null; aisle: Aisle }[] = [];
  for (const i of found.ingredients) {
    const name = i.name.trim().replace(/\s+/g, " ").slice(0, 80);
    const key = ingredientKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push({ name, quantity: i.quantity?.trim().slice(0, 40) || null, aisle: AISLES.includes(i.aisle) ? i.aisle : "other" });
  }
  return list.slice(0, MAX_INGREDIENTS);
}

interface ShoppingDayRow {
  day: string;
  recipe_id: string;
  name: string;
  url: string;
  read: boolean;
}

/** A week's recipes (eating in) with their ingredients and which are in the house. Recipes not read yet have null ingredients. */
async function loadShoppingMeals(db: Queryable, weekId: string): Promise<ShoppingMeal[]> {
  const days = (
    await db.query<ShoppingDayRow>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, r.id AS recipe_id, r.name, r.url, r.ingredients_read_at IS NOT NULL AS read
         FROM schedule_day d JOIN favourite_recipe r ON r.id = d.meal_recipe_id
        WHERE d.week_id = $1 AND NOT d.eat_out
        ORDER BY d.day`,
      [weekId],
    )
  ).rows;
  const ingredients = (
    await db.query<{ recipe_id: string; name: string; quantity: string | null; aisle: Aisle }>(
      "SELECT recipe_id, name, quantity, aisle FROM recipe_ingredient WHERE recipe_id = ANY($1::uuid[]) ORDER BY position",
      [days.map((d) => d.recipe_id)],
    )
  ).rows;
  const have = (
    await db.query<{ day: string; recipe_id: string; item: string }>(
      "SELECT to_char(day, 'YYYY-MM-DD') AS day, recipe_id, item FROM schedule_have WHERE week_id = $1",
      [weekId],
    )
  ).rows;
  return days.map((d) => ({
    date: d.day,
    recipeId: d.recipe_id,
    name: d.name,
    url: d.url,
    ingredients: d.read
      ? ingredients
          .filter((i) => i.recipe_id === d.recipe_id)
          .map((i) => ({
            name: i.name,
            quantity: i.quantity,
            aisle: i.aisle,
            have: have.some((h) => h.day === d.day && h.recipe_id === d.recipe_id && h.item === ingredientKey(i.name)),
          }))
      : null,
  }));
}

export function buildRouter(
  db: Db,
  options: Pick<AppOptions, "google" | "fetchPage" | "readRecipe" | "readIngredients" | "addressSearch" | "maps" | "readRestaurant" | "suggestMeals"> & {
    webOrigins?: string[];
  } = {},
): Router {
  const router = new Router();
  const me = (userId: string, email: string, req?: Request) =>
    loadMe(db, userId, email, { addressSearch: options.addressSearch !== undefined, mealSuggestions: options.suggestMeals !== undefined }, req);
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
    return { body: await me(userId, email, req) };
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

  router.add("PUT", "/api/family/preferences", async (req) => {
    const { member } = await requireAdmin(db, req);
    const b = v.object(req.body);
    const times = v.object(b.dinnerTimes);
    const weekday = v.optionalPmHalfHour(times.weekday, "Mid-week dinner time");
    const weekend = v.optionalPmHalfHour(times.weekend, "Weekend dinner time");
    const eatOuts = v.perWeek(b.eatOutsPerWeek, "Eat-outs per week");
    const mealKits = v.perWeek(b.mealKitsPerWeek, "Meal kits per week");
    if (eatOuts + mealKits > 7) throw new HttpError(400, "Eat-outs and meal kits together can't be more than 7 a week");
    const row = (
      await db.query<Pick<FamilyRow, PreferenceColumns>>(
        `UPDATE family SET dinner_weekday = $1, dinner_weekend = $2, eat_outs_per_week = $3, meal_kits_per_week = $4
          WHERE id = $5 RETURNING dinner_weekday, dinner_weekend, eat_outs_per_week, meal_kits_per_week`,
        [weekday, weekend, eatOuts, mealKits, member.family_id],
      )
    ).rows[0];
    return { body: toPreferences(row) };
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

  // Admins can edit anyone; everyone can edit their own name, familiar name, life stage, diet and allergies.
  router.add("PATCH", "/api/family/members/:id", async (req) => {
    const { member: self } = await requireMember(db, req);
    const target = await familyMember(db, self.family_id, req.params.id);
    const isSelf = target.id === self.id;
    if (self.role !== "admin" && !isSelf) throw new HttpError(403, "Only a Family Manager can change other members");

    const b = v.object(req.body);
    const name = b.name === undefined ? target.name : v.text(b.name, "Name");
    const familiarName = b.familiarName === undefined ? target.familiar_name : v.optionalText(b.familiarName, "Familiar name", 40);
    const lifeStage = b.lifeStage === undefined ? target.life_stage : v.lifeStage(b.lifeStage);
    const diet = b.diet === undefined ? target.diet : v.diet(b.diet);
    const allergies = b.allergies === undefined ? target.allergies : v.allergies(b.allergies);
    const wfhDays = b.workFromHomeDays === undefined ? target.wfh_days : v.weekdays(b.workFromHomeDays);
    if (lifeStage !== "adult" && wfhDays.length && b.workFromHomeDays !== undefined) {
      throw new HttpError(400, "Only adults can have work-from-home days");
    }
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
      "UPDATE family_member SET name = $1, familiar_name = $2, life_stage = $3, diet = $4, allergies = $5, role = $6, wfh_days = $7 WHERE id = $8",
      [name, familiarName, lifeStage, diet, allergies, role, lifeStage === "adult" ? wfhDays : [], target.id],
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
      `SELECT i.id, i.code, i.member_id, COALESCE(m.familiar_name, m.name) AS member_name, i.created_at, i.expires_at
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
      if (target.user_id) throw new HttpError(400, `${target.familiar_name ?? target.name} already has their own login`);
      if (!canSignIn(target.life_stage)) throw new HttpError(400, "Only adults and teenagers can be invited to sign in");
    }
    const { rows } = await db.query<InviteRow>(
      `INSERT INTO invite (family_id, code, created_by, member_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
       RETURNING id, code, member_id, NULL::text AS member_name, created_at, expires_at`,
      [member.family_id, newInviteCode(), member.id, target?.id ?? null, INVITE_DAYS],
    );
    const body = toInvite({ ...rows[0], member_name: target ? (target.familiar_name ?? target.name) : null });
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
      `SELECT f.name AS family_name, COALESCE(m.familiar_name, m.name) AS invited_by, COALESCE(t.familiar_name, t.name) AS member_name, i.expires_at, i.accepted_at
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
  // Reads a restaurant's link for its name and details, to check and correct before adding it.
  router.add("POST", "/api/family/restaurants/preview", async (req) => {
    const { member } = await requireMember(db, req);
    const url = v.webUrl(v.object(req.body).url, "Restaurant link");
    const found = await readRestaurantPage(options, url);
    const saved = await db.query<{ name: string }>(
      "SELECT name FROM restaurant WHERE family_id = $1 AND (url = $2 OR lower(name) = lower($3)) LIMIT 1",
      [member.family_id, url, found?.name ?? ""],
    );
    const body: RestaurantPreview = {
      url,
      found: found !== null,
      name: found?.name ?? null,
      cuisine: found?.cuisine ?? null,
      address: found?.address ?? null,
      bookingUrl: found?.bookingUrl ?? null,
      alreadySaved: saved.rows[0]?.name ?? null,
    };
    return { body };
  });

  router.add("POST", "/api/family/restaurants", async (req) => {
    const { member } = await requireMember(db, req);
    const typed = restaurantInput(req.body, true);
    const nameTaken = async (name: string) => {
      const taken = await db.query("SELECT 1 FROM restaurant WHERE family_id = $1 AND lower(name) = lower($2)", [member.family_id, name]);
      if (taken.rowCount) throw new HttpError(409, `${name} is already one of your restaurants`);
    };
    if (typed.name) await nameTaken(typed.name);
    const picked = await pickedPlace(typed);
    const r = await fillFromPage(options, typed);
    if (!r.name) throw new HttpError(400, "Couldn't find the restaurant's name from its link. Type it in");
    if (!typed.name) await nameTaken(r.name);
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

  // --- ingredients ----------------------------------------------------------
  // Read from a recipe's page once, the first time it's picked for a day, and kept. A failed read isn't kept,
  // so it's tried again next time.

  const reading = new Map<string, Promise<void>>();
  const readIngredients = (recipeId: string): Promise<void> => {
    const reader = options.readIngredients;
    if (!reader) return Promise.resolve();
    let pending = reading.get(recipeId);
    if (!pending) {
      pending = (async () => {
        try {
          const recipe = (
            await db.query<{ url: string }>("SELECT url FROM favourite_recipe WHERE id = $1 AND ingredients_read_at IS NULL", [recipeId])
          ).rows[0];
          if (!recipe) return; // Already read, or removed.
          const page = await (options.fetchPage ?? fetchPage)(recipe.url);
          const found = tidyIngredients(await reader({ url: page.url, text: pageText(page.html) }));
          await withTransaction(db, async (tx) => {
            const still = await tx.query("SELECT 1 FROM favourite_recipe WHERE id = $1 AND ingredients_read_at IS NULL FOR UPDATE", [recipeId]);
            if (!still.rowCount) return;
            await tx.query(
              `INSERT INTO recipe_ingredient (recipe_id, position, name, quantity, aisle)
               SELECT $1, t.position, t.name, t.quantity, t.aisle
                 FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS t(name, quantity, aisle, position)`,
              [recipeId, found.map((i) => i.name), found.map((i) => i.quantity), found.map((i) => i.aisle)],
            );
            await tx.query("UPDATE favourite_recipe SET ingredients_read_at = now() WHERE id = $1", [recipeId]);
          });
        } catch (err) {
          console.error("Reading a recipe's ingredients failed", err);
        } finally {
          reading.delete(recipeId);
        }
      })();
      reading.set(recipeId, pending);
    }
    return pending;
  };

  /** Starts reading the ingredients of any recipes just picked, so they're ready for the shopping list. */
  const readPicked = (days: DayInput[]) => {
    for (const d of days) if (d.meal?.recipeId) void readIngredients(d.meal.recipeId);
  };

  /** A week's shopping list, reading any of its recipes' ingredients that haven't been read yet. */
  const shoppingList = async (familyId: string, startsOn: string): Promise<ShoppingList> => {
    const id = await weekId(db, familyId, startsOn);
    let meals = await loadShoppingMeals(db, id);
    const unread = [...new Set(meals.filter((m) => !m.ingredients).map((m) => m.recipeId))];
    if (unread.length && options.readIngredients) {
      await Promise.all(unread.map(readIngredients));
      meals = await loadShoppingMeals(db, id);
    }
    const bought = (await db.query<{ item: string }>("SELECT item FROM shopping_bought WHERE week_id = $1", [id])).rows.map((r) => r.item);
    const extras = (
      await db.query<ShoppingExtra>("SELECT id, name, aisle FROM shopping_extra WHERE week_id = $1 ORDER BY created_at, id", [id])
    ).rows;
    const adjusted: Record<string, Quantity> = {};
    const quantities = await db.query<{ item: string; amount: string; unit: string | null }>(
      "SELECT item, amount, unit FROM shopping_quantity WHERE week_id = $1",
      [id],
    );
    for (const r of quantities.rows) adjusted[r.item] = { amount: Number(r.amount), unit: r.unit };
    return { startsOn, meals, extras, adjusted, items: shoppingItems(meals, bought, extras, adjusted) };
  };

  // --- weekly schedule ----------------------------------------------------
  // Weeks run Monday to Sunday. Like recipes, the schedule belongs to the family: anyone in it can change it,
  // but only a Family Manager chooses the meals.

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
    // Adults' usual work-from-home days carry into each new week.
    const usual = (
      await db.query<{ id: string; wfh_days: number[] }>("SELECT id, wfh_days FROM family_member WHERE family_id = $1 AND life_stage = 'adult'", [
        member.family_id,
      ])
    ).rows;
    const days = daysToPlan(startsOn, today).map(
      (date): DayInput => ({
        date,
        eatOut: false,
        memberIds: familyIds,
        guests: 0,
        workingFromHomeIds: usual.filter((m) => m.wfh_days.includes(isoWeekday(date))).map((m) => m.id),
      }),
    );
    // When days are listed, only those days are planned (the rest are left out of the schedule).
    if (b.days !== undefined) {
      if (!Array.isArray(b.days)) throw new HttpError(400, "Days must be a list");
      const planned = new Map<string, DayInput>();
      for (const raw of b.days) {
        const d = v.object(raw);
        const date = v.isoDate(d.date, "Day");
        if (!days.some((day) => day.date === date)) {
          if (weekDays(startsOn).includes(date)) throw new HttpError(400, `${date} has already passed`);
          throw new HttpError(400, `${date} isn't in the week starting ${startsOn}`);
        }
        if (planned.has(date)) throw new HttpError(400, `${date} is listed twice`);
        const who = dinner(d, familyIds);
        planned.set(date, {
          date,
          ...who,
          meal: await mealFrom(db, d, member, who.eatOut),
          workingFromHomeIds: await workingFromHome(db, d, member.family_id),
        });
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
    readPicked(days);
    return { status: 201, body: (await loadWeeks(db, member.family_id, startsOn))[0] };
  });

  router.add("PATCH", "/api/family/weeks/:startsOn/days/:date", async (req) => {
    const { member } = await requireMember(db, req);
    const startsOn = weekStart(req.params.startsOn);
    const date = req.params.date;
    if (!weekDays(startsOn).includes(date)) throw new HttpError(404, "That day isn't in this week");
    const b = v.object(req.body);
    const who = dinner(b, await familyMemberIds(db, member.family_id));
    const day: DayInput = {
      date,
      ...who,
      meal: await mealFrom(db, b, member, who.eatOut),
      workingFromHomeIds: await workingFromHome(db, b, member.family_id),
    };
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
    readPicked([day]);
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

  // Suggests dinners for the days of a week that don't have one yet, fitted around who's in, working from home,
  // events and the family's preferences. Nothing is saved: the suggestions fill in the week form, to change as wanted.
  router.add("POST", "/api/family/suggestions", async (req) => {
    const { member } = await requireAdmin(db, req);
    const suggest = options.suggestMeals;
    if (!suggest) throw new HttpError(503, "Meal suggestions aren't set up yet");
    const b = v.object(req.body);
    if (!Array.isArray(b.days) || b.days.length === 0 || b.days.length > 7) throw new HttpError(400, "Send the week's days");
    const familyIds = await familyMemberIds(db, member.family_id);
    const days = b.days
      .map((raw) => {
        const d = v.object(raw);
        const date = v.isoDate(d.date, "Day");
        const who = dinner(d, familyIds);
        const wfh = d.workingFromHomeIds === undefined ? [] : v.ids(d.workingFromHomeIds, "Working from home");
        return { date, ...who, workingFromHomeIds: wfh.filter((id) => familyIds.includes(id)), chosen: chosenMeal(d.meal) };
      })
      .sort((a, c) => a.date.localeCompare(c.date));
    if (days.some((d) => mondayOf(d.date) !== mondayOf(days[0].date))) throw new HttpError(400, "The days must all be in one week");
    if (new Set(days.map((d) => d.date)).size !== days.length) throw new HttpError(400, "A day is listed twice");
    // Days that have passed (allowing a day for time zones) are left as they are.
    const earliest = addDays(new Date().toISOString().slice(0, 10), -1);
    const needsSuggestion = (d: (typeof days)[number]) => d.chosen === null && d.date >= earliest;
    if (!days.some(needsSuggestion)) return { body: { suggestions: [] } };

    const fam = (await db.query<FamilyRow>("SELECT * FROM family WHERE id = $1", [member.family_id])).rows[0];
    const prefs = toPreferences(fam);
    const members = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.family_id = $1 ORDER BY m.created_at`, [member.family_id])).rows.map(
      toMember,
    );
    const nameOf = (id: string) => {
      const m = members.find((x) => x.id === id);
      return m ? displayName(m) : "Someone";
    };
    const withStage = (id: string) => `${nameOf(id)} (${members.find((x) => x.id === id)?.lifeStage ?? "adult"})`;
    const events = await loadEvents(db, member.family_id);
    const recipes = (
      await db.query<RecipeRow>(`${recipeSelect("$2")} WHERE r.family_id = $1 ORDER BY r.name`, [member.family_id, member.id])
    ).rows.map(toRecipe);
    const restaurants = (
      await db.query<RestaurantRow>(`${restaurantSelect("$2")} WHERE r.family_id = $1 ORDER BY lower(r.name)`, [member.family_id, member.id])
    ).rows.map(toRestaurant);
    const last = (dates: string[]) => (dates.length ? dates.reduce((a, c) => (a > c ? a : c)) : null);

    const brief: SuggestBrief = {
      preferences: { eatOutsPerWeek: prefs.eatOutsPerWeek, mealKitsPerWeek: prefs.mealKitsPerWeek },
      family: members.map((m) => ({ name: displayName(m), lifeStage: m.lifeStage, diet: m.diet, allergies: m.allergies })),
      days: days.map((d) => ({
        date: d.date,
        weekday: new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        dinnerTime: (isoWeekday(d.date) <= 5 ? prefs.dinnerTimes.weekday : prefs.dinnerTimes.weekend) ?? DEFAULT_DINNER_TIME,
        eatingOut: d.eatOut,
        alreadyChosen: d.chosen,
        needsSuggestion: needsSuggestion(d),
        joiningForDinner: d.memberIds.map(nameOf),
        guests: d.guests,
        adultsWorkingFromHome: d.workingFromHomeIds.map(nameOf),
        events: events
          .filter((e) => eventOn(e, d.date))
          .map((e) => ({ title: e.title, start: e.startTime, end: e.endTime, going: e.memberIds.map(withStage) })),
      })),
      recipes: recipes.map((r) => ({
        id: r.id,
        name: r.name,
        cookingMinutes: r.cookingMinutes,
        mainProtein: r.mainProtein,
        familyRating: r.averageRating,
        cookedBefore: r.prepared,
        timesChosen: r.chosenOn.length,
        lastChosen: last(r.chosenOn),
      })),
      restaurants: restaurants.map((r) => ({
        id: r.id,
        name: r.name,
        cuisine: r.cuisine,
        driveMinutes: r.driveMinutes,
        familyRating: r.averageRating,
        timesChosen: r.chosenOn.length,
        lastChosen: last(r.chosenOn),
      })),
    };

    let found: Awaited<ReturnType<MealSuggester>>;
    try {
      found = await suggest(brief);
    } catch (err) {
      console.error("Suggesting meals failed", err);
      throw new HttpError(502, "Couldn't come up with suggestions just now, try again in a moment");
    }

    // Only what fits: one suggestion per day that needs one, from the family's own recipes and restaurants.
    const suggestions: MealSuggestion[] = [];
    const typed = (name: string | null) => name?.trim().slice(0, MAX_MEAL_NAME) || null;
    for (const s of found.days) {
      const day = days.find((d) => d.date === s.date);
      if (!day || !needsSuggestion(day) || suggestions.some((x) => x.date === s.date)) continue;
      const reason = s.reason.trim().slice(0, 200);
      const meal = (m: Partial<ScheduleMeal>): ScheduleMeal => ({ name: "", mealKit: false, recipeId: null, restaurantId: null, url: null, ...m });
      let suggestion: Omit<MealSuggestion, "date" | "reason"> | null = null;
      if (s.choice === "restaurant") {
        const r = restaurants.find((x) => x.id === s.restaurantId);
        if (r) suggestion = { eatOut: true, meal: meal({ name: r.name, restaurantId: r.id, url: r.url }) };
      } else if (s.choice === "otherOut") {
        const name = typed(s.name);
        if (name) suggestion = { eatOut: true, meal: meal({ name }) };
      } else if (day.eatOut) {
        continue; // Already eating out: only somewhere to eat out will do.
      } else if (s.choice === "recipe") {
        const r = recipes.find((x) => x.id === s.recipeId);
        if (r) suggestion = { eatOut: false, meal: meal({ name: r.name, recipeId: r.id, url: r.url }) };
      } else if (s.choice === "mealKit") {
        suggestion = { eatOut: false, meal: meal({ mealKit: true }) };
      } else {
        const name = typed(s.name);
        if (name) suggestion = { eatOut: false, meal: meal({ name }) };
      }
      if (suggestion) suggestions.push({ date: s.date, ...suggestion, reason });
    }
    return { body: { suggestions: suggestions.sort((a, c) => a.date.localeCompare(c.date)) } };
  });

  // --- events ---
  // Anyone in the family can add, change or remove them. They're shown on the schedule; they don't change who's
  // in for dinner by themselves.

  router.add("GET", "/api/family/events", async (req) => {
    const { member } = await requireMember(db, req);
    return { body: await loadEvents(db, member.family_id) };
  });

  router.add("POST", "/api/family/events", async (req) => {
    const { member } = await requireMember(db, req);
    const e = eventFrom(v.object(req.body), await familyMemberIds(db, member.family_id));
    const id = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO schedule_event (family_id, title, day, starts_at, ends_at, weekly, until, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [member.family_id, e.title, e.date, e.startTime, e.endTime, e.weekly, e.until, member.id],
      );
      await saveEventMembers(tx, rows[0].id, e.memberIds);
      return rows[0].id;
    });
    return { status: 201, body: (await loadEvents(db, member.family_id, id))[0] };
  });

  router.add("PATCH", "/api/family/events/:id", async (req) => {
    const { member } = await requireMember(db, req);
    const id = v.uuid(req.params.id);
    const [existing] = await loadEvents(db, member.family_id, id);
    if (!existing) throw new HttpError(404, "That event isn't in your schedule");
    const e = eventFrom(v.object(req.body), await familyMemberIds(db, member.family_id), existing);
    await withTransaction(db, async (tx) => {
      await tx.query(
        "UPDATE schedule_event SET title = $2, day = $3, starts_at = $4, ends_at = $5, weekly = $6, until = $7 WHERE id = $1",
        [id, e.title, e.date, e.startTime, e.endTime, e.weekly, e.until],
      );
      await saveEventMembers(tx, id, e.memberIds);
    });
    return { body: (await loadEvents(db, member.family_id, id))[0] };
  });

  router.add("DELETE", "/api/family/events/:id", async (req) => {
    const { member } = await requireMember(db, req);
    const { rowCount } = await db.query("DELETE FROM schedule_event WHERE id = $1 AND family_id = $2", [
      v.uuid(req.params.id),
      member.family_id,
    ]);
    if (!rowCount) throw new HttpError(404, "That event isn't in your schedule");
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

  // --- shopping list ------------------------------------------------------
  // Anyone in the family can mark what's already in the house and tick items off.

  router.add("GET", "/api/family/weeks/:startsOn/shopping", async (req) => {
    const { member } = await requireMember(db, req);
    return { body: await shoppingList(member.family_id, req.params.startsOn) };
  });

  // An ingredient of a day's recipe is already in the house (or isn't after all).
  router.add("PUT", "/api/family/weeks/:startsOn/days/:date/have", async (req) => {
    const { member } = await requireMember(db, req);
    const id = await weekId(db, member.family_id, req.params.startsOn);
    const b = v.object(req.body);
    const item = ingredientKey(v.text(b.name, "Ingredient", 80));
    if (typeof b.have !== "boolean") throw new HttpError(400, "Have must be true or false");
    const day = (
      await db.query<{ recipe_id: string | null }>("SELECT meal_recipe_id AS recipe_id FROM schedule_day WHERE week_id = $1 AND day = $2", [
        id,
        v.isoDate(req.params.date, "Day"),
      ])
    ).rows[0];
    if (!day) throw new HttpError(404, "That day isn't in this week");
    if (!day.recipe_id) throw new HttpError(400, "That day's meal isn't one of your recipes");
    const names = (await db.query<{ name: string }>("SELECT name FROM recipe_ingredient WHERE recipe_id = $1", [day.recipe_id])).rows;
    if (!names.some((n) => ingredientKey(n.name) === item)) throw new HttpError(400, "That isn't one of the recipe's ingredients");
    if (b.have) {
      await db.query("INSERT INTO schedule_have (week_id, day, recipe_id, item) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [
        id,
        req.params.date,
        day.recipe_id,
        item,
      ]);
    } else {
      await db.query("DELETE FROM schedule_have WHERE week_id = $1 AND day = $2 AND recipe_id = $3 AND item = $4", [
        id,
        req.params.date,
        day.recipe_id,
        item,
      ]);
    }
    return { status: 204 };
  });

  // Anything else for the week (milk, bread…), added by hand.
  router.add("POST", "/api/family/weeks/:startsOn/shopping/extras", async (req) => {
    const { member } = await requireMember(db, req);
    const id = await weekId(db, member.family_id, req.params.startsOn);
    const name = v.text(v.object(req.body).name, "Item", MAX_EXTRA_NAME).replace(/\s+/g, " ");
    const { rowCount } = await db.query(
      `INSERT INTO shopping_extra (week_id, name, aisle, added_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (week_id, lower(name)) DO NOTHING`,
      [id, name, groceryAisle(name), member.id],
    );
    if (!rowCount) throw new HttpError(409, `${name} is already on this week's list`);
    // Added again after being ticked off: it's needed again.
    await db.query("DELETE FROM shopping_bought WHERE week_id = $1 AND item = $2", [id, ingredientKey(name)]);
    return { status: 201, body: await shoppingList(member.family_id, req.params.startsOn) };
  });

  router.add("DELETE", "/api/family/weeks/:startsOn/shopping/extras/:id", async (req) => {
    const { member } = await requireMember(db, req);
    const id = await weekId(db, member.family_id, req.params.startsOn);
    const { rowCount } = await db.query("DELETE FROM shopping_extra WHERE id = $1 AND week_id = $2", [v.uuid(req.params.id), id]);
    if (!rowCount) throw new HttpError(404, "That isn't on this week's list");
    return { body: await shoppingList(member.family_id, req.params.startsOn) };
  });

  // How much of an item to buy (the − and + buttons); null goes back to what the recipes add up to.
  router.add("PUT", "/api/family/weeks/:startsOn/shopping/quantity", async (req) => {
    const { member } = await requireMember(db, req);
    const id = await weekId(db, member.family_id, req.params.startsOn);
    const b = v.object(req.body);
    const item = ingredientKey(v.text(b.key, "Item", 80));
    if (b.quantity === null) {
      await db.query("DELETE FROM shopping_quantity WHERE week_id = $1 AND item = $2", [id, item]);
      return { status: 204 };
    }
    const q = v.object(b.quantity);
    if (typeof q.amount !== "number" || !(q.amount > 0) || q.amount > 100_000) throw new HttpError(400, "Amount must be a number above 0");
    const unit = q.unit === null || q.unit === undefined ? null : v.text(q.unit, "Unit", 30);
    await db.query(
      `INSERT INTO shopping_quantity (week_id, item, amount, unit) VALUES ($1, $2, $3, $4)
       ON CONFLICT (week_id, item) DO UPDATE SET amount = EXCLUDED.amount, unit = EXCLUDED.unit`,
      [id, item, q.amount, unit],
    );
    return { status: 204 };
  });

  router.add("PUT", "/api/family/weeks/:startsOn/shopping/bought", async (req) => {
    const { member } = await requireMember(db, req);
    const id = await weekId(db, member.family_id, req.params.startsOn);
    const b = v.object(req.body);
    const item = ingredientKey(v.text(b.key, "Item", 80));
    if (typeof b.bought !== "boolean") throw new HttpError(400, "Bought must be true or false");
    if (b.bought) {
      await db.query("INSERT INTO shopping_bought (week_id, item) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, item]);
    } else {
      await db.query("DELETE FROM shopping_bought WHERE week_id = $1 AND item = $2", [id, item]);
    }
    return { status: 204 };
  });

  return router;
}

export function createApp(db: Db, options: AppOptions): Server {
  return createServer(listener(buildRouter(db, options), options.webOrigins));
}
