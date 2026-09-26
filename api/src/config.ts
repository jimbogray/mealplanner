import { DEFAULT_RECIPE_MODEL } from "./recipe-reader.js";

export interface Config {
  port: number;
  databaseUrl: string;
  /** Origins allowed to call the API from a browser (the static web app's URL). */
  webOrigins: string[];
  /** Apply pending migrations when the server starts. */
  migrateOnStart: boolean;
  /** OAuth client id from Google Cloud Console; enables Sign in with Google. */
  googleClientId: string | null;
  /** Anthropic API key; enables reading recipe pages with Claude. */
  anthropicApiKey: string | null;
  /** Claude model for reading recipe pages. */
  recipeModel: string;
  /** Google Maps Platform key with the Places API (New) enabled; enables searching for the home address. */
  googlePlacesApiKey: string | null;
  /** Azure Maps key; enables finding restaurants on the map and driving times from home. */
  azureMapsKey: string | null;
}

/** Loads api/.env into process.env if it exists (real environment variables win). */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the environment.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl,
    webOrigins: (env.WEB_ORIGIN ?? "http://localhost:5173")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    migrateOnStart: env.MIGRATE_ON_START !== "false",
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    recipeModel: env.RECIPE_MODEL?.trim() || DEFAULT_RECIPE_MODEL,
    googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY?.trim() || null,
    azureMapsKey: env.AZURE_MAPS_KEY?.trim() || null,
  };
}
