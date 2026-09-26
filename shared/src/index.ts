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

/** The UK's 14 major food allergens (also the database's allowed values). */
export const ALLERGENS = [
  "gluten",
  "dairy",
  "egg",
  "peanut",
  "tree_nuts",
  "soy",
  "fish",
  "crustaceans",
  "molluscs",
  "sesame",
  "mustard",
  "celery",
  "lupin",
  "sulphites",
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  gluten: "Gluten",
  dairy: "Dairy (milk)",
  egg: "Egg",
  peanut: "Peanuts",
  tree_nuts: "Tree nuts",
  soy: "Soya",
  fish: "Fish",
  crustaceans: "Shellfish (crustaceans)",
  molluscs: "Molluscs",
  sesame: "Sesame",
  mustard: "Mustard",
  celery: "Celery",
  lupin: "Lupin",
  sulphites: "Sulphites",
};

export function isAllergen(value: unknown): value is Allergen {
  return typeof value === "string" && (ALLERGENS as readonly string[]).includes(value);
}

/** "admin" can add, edit and remove members and create invites. */
export type MemberRole = "admin" | "member";

export interface FamilyMember {
  id: Uuid;
  name: string;
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

/** A UK postal address. */
export interface Address {
  line1: string;
  line2: string | null;
  town: string;
  county: string | null;
  /** Upper case with a single space, e.g. "SW1A 2AA". */
  postcode: string;
  /** WGS84 coordinates from the postcode lookup; null when the address was typed in. */
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

/** Tidies a UK postcode ("sw1a2aa" → "SW1A 2AA"), or returns null if it isn't shaped like one. */
export function normalisePostcode(value: string): string | null {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
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
  /** True when the API can look addresses up by postcode; otherwise addresses are typed in. */
  addressLookup: boolean;
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

/** POST /api/family/address/lookup */
export interface AddressLookupRequest {
  postcode: string;
}

export interface AddressLookupResponse {
  addresses: Address[];
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

/** Add a week. Days that have already passed are left out; others not listed default to everyone joining and no guests. */
export interface AddWeekRequest {
  startsOn: IsoDate;
  /** The person's local date, so "this week" is theirs rather than the server's. */
  today: IsoDate;
  days?: { date: IsoDate; memberIds: Uuid[]; guests: number }[];
}

export interface UpdateDayRequest {
  memberIds: Uuid[];
  guests: number;
}
