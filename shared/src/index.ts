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

export interface Family {
  id: Uuid;
  name: string;
  createdAt: string;
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
