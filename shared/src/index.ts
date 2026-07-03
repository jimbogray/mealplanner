// Shared domain types used by both the API (Azure Functions) and the web SPA.
// Mirrors the Postgres schema in /db.

export type Uuid = string;

export type MemberRole = "admin" | "member";
export type AttendanceResponse = "yes" | "no" | "pending";
export type MealEventStatus = "polling" | "planned" | "cooked";
export type RecipeOrigin = "ai" | "web" | "manual";
export type SmsDirection = "outbound" | "inbound";

export interface Household {
  id: Uuid;
  name: string;
  /** Local time-of-day the daily dinner poll fires, "HH:mm". */
  dinnerPollTime: string;
  /** IANA timezone, e.g. "Europe/London". */
  timezone: string;
}

export interface DietaryPrefs {
  vegetarian?: boolean;
  vegan?: boolean;
  glutenFree?: boolean;
  dislikes?: string[];
  allergies?: string[];
}

export interface FamilyMember {
  id: Uuid;
  householdId: Uuid;
  name: string;
  /** E.164 format, e.g. "+447700900123". */
  phoneE164: string;
  dietaryPrefs: DietaryPrefs;
  role: MemberRole;
  active: boolean;
}

export interface InventoryItem {
  id: Uuid;
  householdId: Uuid;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  /** ISO date "YYYY-MM-DD" or null. */
  expiresOn: string | null;
  updatedAt: string;
}

export interface RecipeIngredient {
  name: string;
  quantity?: number;
  unit?: string;
}

export interface Recipe {
  id: Uuid;
  title: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  tags: string[];
  sourceUrl: string | null;
  imageUrl: string | null;
  nutrition: Record<string, number> | null;
  createdBy: RecipeOrigin;
}

export interface RecipeRating {
  memberId: Uuid;
  recipeId: Uuid;
  score: number; // 1..5
  cookedOn: string; // ISO date
}

export interface MealEvent {
  id: Uuid;
  householdId: Uuid;
  date: string; // ISO date
  recipeId: Uuid | null;
  status: MealEventStatus;
  headcount: number;
}

export interface AttendanceRow {
  mealEventId: Uuid;
  memberId: Uuid;
  response: AttendanceResponse;
  respondedAt: string | null;
}

/** A recipe suggestion returned by the AI engine, scored against current inventory. */
export interface RecipeSuggestion {
  recipe: Recipe;
  /** 0..1 — share of ingredients already available in the fridge. */
  fridgeMatch: number;
  missingIngredients: string[];
  rationale: string;
}
