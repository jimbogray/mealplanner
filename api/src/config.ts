export interface Config {
  port: number;
  databaseUrl: string;
  /** Origins allowed to call the API from a browser (the static web app's URL). */
  webOrigins: string[];
  /** Apply pending migrations when the server starts. */
  migrateOnStart: boolean;
  /** OAuth client id from Google Cloud Console; enables Sign in with Google. */
  googleClientId: string | null;
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
  };
}
