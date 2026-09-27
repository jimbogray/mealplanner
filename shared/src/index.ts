// Types and constants shared by the API and the web app.
// Mirrors the Postgres schema in /db/migrations.

export type Uuid = string;

/** Stage of life for a family member, youngest first. */
export const LIFE_STAGES = ["baby", "toddler", "child", "teenager", "adult"] as const;
export type LifeStage = (typeof LIFE_STAGES)[number];

export const LIFE_STAGE_LABELS: Record<LifeStage, string> = {
  baby: "Baby (0–1)",
  toddler: "Toddler (1–3)",
  child: "Child (4–12)",
  teenager: "Teenager (13–17)",
  adult: "Adult (18+)",
};

/** Only teenagers and adults can have their own login (and so be invited to sign in, or be a Family Manager). */
export function canSignIn(stage: LifeStage): boolean {
  return stage === "teenager" || stage === "adult";
}

export function isLifeStage(value: unknown): value is LifeStage {
  return typeof value === "string" && (LIFE_STAGES as readonly string[]).includes(value);
}

/** Eating pattern; "none" means no restriction. */
export const DIETS = ["none", "vegetarian", "vegan"] as const;
export type Diet = (typeof DIETS)[number];

export const DIET_LABELS: Record<Diet, string> = {
  none: "No restriction",
  vegetarian: "Vegetarian",
  vegan: "Vegan",
};

export function isDiet(value: unknown): value is Diet {
  return typeof value === "string" && (DIETS as readonly string[]).includes(value);
}

/** The US's 9 major food allergens (FALCPA and the FASTER Act), also the database's allowed values. */
export const ALLERGENS = ["dairy", "egg", "fish", "crustaceans", "tree_nuts", "peanut", "wheat", "soy", "sesame"] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  dairy: "Milk",
  egg: "Eggs",
  fish: "Fish",
  crustaceans: "Shellfish",
  tree_nuts: "Tree nuts",
  peanut: "Peanuts",
  wheat: "Wheat",
  soy: "Soy",
  sesame: "Sesame",
};

export function isAllergen(value: unknown): value is Allergen {
  return typeof value === "string" && (ALLERGENS as readonly string[]).includes(value);
}

/** "admin" can add, edit and remove members and create invites. */
export type MemberRole = "admin" | "member";

export interface FamilyMember {
  id: Uuid;
  name: string;
  /** What the family calls them day to day (e.g. "Mum"); null to use their name. */
  familiarName: string | null;
  lifeStage: LifeStage;
  diet: Diet;
  /** In ALLERGENS order. */
  allergies: Allergen[];
  role: MemberRole;
  /** True when the member has their own login (joined via sign-up or an invite). */
  hasAccount: boolean;
  email: string | null;
  createdAt: string;
}

/** The name to show for a member around the app: their familiar name, or else their name. */
export function displayName(member: Pick<FamilyMember, "name" | "familiarName">): string {
  return member.familiarName ?? member.name;
}

/** A US postal address. */
export interface Address {
  /** e.g. "1600 Pennsylvania Ave NW" */
  line1: string;
  /** e.g. "Apt 4B" */
  line2: string | null;
  city: string;
  /** Two-letter state code, e.g. "DC". */
  state: string;
  /** Five digits, e.g. "20500". */
  zip: string;
  /** WGS84 coordinates from Google; null for an address typed in before address search. */
  latitude: number | null;
  longitude: number | null;
}

export interface Family {
  id: Uuid;
  name: string;
  /** The family's home address, if a Family Manager has added one. */
  address: Address | null;
  createdAt: string;
}

/** The five-digit ZIP code in a ZIP or ZIP+4 ("20500-0003" → "20500"), or null if it isn't one. */
export function normaliseZip(value: string): string | null {
  return /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(value)?.[1] ?? null;
}

export interface Invite {
  id: Uuid;
  code: string;
  /** Set when the invite is for an existing member (added by an admin) to get their own login. */
  memberId: Uuid | null;
  memberName: string | null;
  createdAt: string;
  expiresAt: string;
}

/** What GET /api/me returns. family/member are null for a login that isn't in a family (e.g. after being removed). */
export interface Me {
  user: { id: Uuid; email: string };
  family: Family | null;
  member: FamilyMember | null;
  members: FamilyMember[];
  /** True when the API can search for addresses (Google Places is set up). */
  addressSearch: boolean;
}

/** Public details about an invite, shown on the join page before sign-up. */
export interface InvitePreview {
  familyName: string;
  /** The existing member this invite signs in as, if any; name and life stage are then already set. */
  memberName: string | null;
  invitedBy: string;
  expiresAt: string;
}

export interface AuthResponse {
  token: string;
  me: Me;
}

export interface SignupRequest {
  email: string;
  password: string;
  /** name and lifeStage are ignored when the invite is for an existing member. */
  name?: string;
  lifeStage?: LifeStage;
  /** Create a new family with this name… */
  familyName?: string;
  /** …or join an existing family through an invite code. */
  inviteCode?: string;
}

/**
 * Sign in with a Google ID token. To sign up at the same time, also send lifeStage and
 * familyName or inviteCode (name defaults to the Google profile name).
 */
export interface GoogleAuthRequest {
  credential: string;
  name?: string;
  lifeStage?: LifeStage;
  familyName?: string;
  inviteCode?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface MemberInput {
  name: string;
  lifeStage: LifeStage;
  diet?: Diet;
  allergies?: Allergen[];
  /** When a Family Manager adds someone: "admin" makes them a Co-Manager. Ignored elsewhere. */
  role?: MemberRole;
}

export interface MemberUpdate {
  name?: string;
  /** Blank or null clears it. */
  familiarName?: string | null;
  lifeStage?: LifeStage;
  diet?: Diet;
  allergies?: Allergen[];
  role?: MemberRole;
}

export interface CreateInviteRequest {
  /** Invite this existing member (who has no login yet) to sign in as themselves. */
  memberId?: Uuid;
}

/** Create a family for a signed-in user who isn't in one. */
export interface CreateFamilyRequest {
  familyName: string;
  name: string;
  lifeStage: LifeStage;
}

/** One match while searching for an address, e.g. "1600 Pennsylvania Avenue NW" / "Washington, DC, USA". */
export interface AddressSuggestion {
  placeId: string;
  text: string;
  secondaryText: string | null;
}

/**
 * POST /api/family/address/search. sessionToken is a random id the web app makes for one search,
 * sent with each keystroke's search and with the pick (Google bills them together).
 */
export interface AddressSearchRequest {
  input: string;
  sessionToken: string;
}

export interface AddressSearchResponse {
  suggestions: AddressSuggestion[];
}

/** PUT /api/family/address: saves the picked suggestion's full address. */
export interface SetAddressRequest {
  placeId: string;
  sessionToken: string;
}

export interface ApiError {
  error: string;
}

/** What's known about a recipe: read from its page, or typed in. */
export interface RecipeDetails {
  /** The dish, e.g. "Chicken tikka masala". */
  name: string;
  description: string | null;
  /** Approximate total time to make it. */
  cookingMinutes: number | null;
  /** e.g. "Chicken", "Tofu"; null when there isn't one. */
  mainProtein: string | null;
  imageUrl: string | null;
  /** e.g. "BBC Good Food", from the page's metadata. */
  siteName: string | null;
}

/** A recipe page a family has saved as a favourite. */
export interface FavouriteRecipe extends RecipeDetails {
  id: Uuid;
  url: string;
  /** The family has cooked it. Only Family Managers can change this. */
  prepared: boolean;
  /** The family's average star rating (1 to 5, to one decimal place); null if nobody has rated it. */
  averageRating: number | null;
  ratingCount: number;
  /** The signed-in member's own rating (1 to 5); null if they haven't rated it. */
  myRating: number | null;
  /** Name of the member who added it; null if they've since left. */
  addedBy: string | null;
  createdAt: string;
}

/**
 * What POST /api/family/recipes/preview found on a page, before it's saved.
 * isRecipe is null when the page couldn't be read (or automatic reading is off);
 * fields that couldn't be found are null (name is null rather than a guess).
 */
export interface RecipePreview extends Omit<RecipeDetails, "name"> {
  url: string;
  isRecipe: boolean | null;
  name: string | null;
  /** Already one of this family's favourites. */
  alreadySaved: boolean;
}

/** Save a favourite: the preview's details, as confirmed or filled in by the person adding it. */
export interface AddFavouriteRequest {
  url: string;
  name: string;
  description?: string | null;
  cookingMinutes?: number | null;
  mainProtein?: string | null;
  imageUrl?: string | null;
  siteName?: string | null;
}

/** A calendar date, "YYYY-MM-DD". */
export type IsoDate = string;

/** Adds days to a calendar date (no time zones involved). */
export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday on or before a calendar date. */
export function mondayOf(date: IsoDate): IsoDate {
  const isoDay = new Date(`${date}T00:00:00Z`).getUTCDay() || 7; // Monday 1 … Sunday 7
  return addDays(date, 1 - isoDay);
}

/** True for a real calendar date written as "YYYY-MM-DD". */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The seven days of a week, Monday first. */
export function weekDays(startsOn: IsoDate): IsoDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(startsOn, i));
}

/** The days of a week still to come: this week's days from today on, or every day of a later week. */
export function daysToPlan(startsOn: IsoDate, today: IsoDate): IsoDate[] {
  return weekDays(startsOn).filter((d) => d >= today);
}

/**
 * The week a family can add next: this week if they don't have it yet, otherwise the
 * week after their last one. `today` is the person's own local date.
 */
export function nextWeekToAdd(weeks: IsoDate[], today: IsoDate): IsoDate {
  const current = mondayOf(today);
  if (!weeks.includes(current)) return current;
  return addDays(weeks.reduce((a, b) => (a > b ? a : b)), 7);
}

export const MAX_GUESTS = 50;

/** Dinner on one day: which family members are joining, and how many guests. */
export interface ScheduleDay {
  date: IsoDate;
  /** The family is eating out: memberIds is empty and guests is 0. */
  eatOut: boolean;
  memberIds: Uuid[];
  guests: number;
}

/** A week of the family's schedule, Monday to Sunday. */
export interface ScheduleWeek {
  id: Uuid;
  /** Always a Monday. */
  startsOn: IsoDate;
  /** In date order; this week, when added, starts from the day it was added (earlier days are left out). */
  days: ScheduleDay[];
}

/**
 * Add a week. Days that have already passed are left out. Without `days`, every other day is planned with
 * everyone joining and no guests; with `days`, only the days listed are planned.
 */
export interface AddWeekRequest {
  startsOn: IsoDate;
  /** The person's local date, so "this week" is theirs rather than the server's. */
  today: IsoDate;
  days?: ({ date: IsoDate } & UpdateDayRequest)[];
}

/** Who's joining and how many guests; or eatOut, which leaves out everyone (memberIds and guests aren't needed). */
export interface UpdateDayRequest {
  eatOut?: boolean;
  memberIds?: Uuid[];
  guests?: number;
}

/** A restaurant the family likes. */
export interface Restaurant {
  id: Uuid;
  name: string;
  /** Its website, menu or map listing. */
  url: string | null;
  /** e.g. "Ask for the window table. Kids love the pizza." */
  notes: string | null;
  /** Typed in, or the address the map service found for it by name. */
  address: string | null;
  /** e.g. "Italian"; typed in, or read from its web page. */
  cuisine: string | null;
  /** Where to book a table (OpenTable, the restaurant's own page…); typed in, or read from its web page. */
  bookingUrl: string | null;
  /** Driving time from the family's home; null when there's no home address or it couldn't be worked out. */
  driveMinutes: number | null;
  /** The family's average star rating (1 to 5, to one decimal place); null if nobody has rated it. */
  averageRating: number | null;
  ratingCount: number;
  /** The signed-in member's own rating (1 to 5); null if they haven't rated it. */
  myRating: number | null;
  /** Name of the member who added it; null if they've since left. */
  addedBy: string | null;
  createdAt: string;
}

/** Add a restaurant, or change one (the whole thing is replaced). */
export interface RestaurantInput {
  /** May be left out when adding one with a link: it's then read from the page (400 if it can't be). */
  name?: string;
  url?: string | null;
  notes?: string | null;
  /** Leave out to have it found on the map by name, near the family's home. */
  address?: string | null;
  /** Left blank, these are read from the restaurant's web page (url) when there is one. */
  cuisine?: string | null;
  bookingUrl?: string | null;
  /** An address suggestion picked from POST /api/family/restaurants/address/search, with that search's session. */
  placeId?: string;
  sessionToken?: string;
  /** False to save exactly what's given, without reading the link (e.g. after a preview). */
  readLink?: boolean;
}

/** What a restaurant's link says about it, for checking and correcting before it's added. */
export interface RestaurantPreview {
  url: string;
  /** False if the page couldn't be read or isn't a restaurant's; the details are then all null. */
  found: boolean;
  name: string | null;
  cuisine: string | null;
  address: string | null;
  bookingUrl: string | null;
  /** The name of a restaurant the family already has with this link or name, if any. */
  alreadySaved: string | null;
}
