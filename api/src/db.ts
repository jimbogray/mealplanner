import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, options: pg.PoolConfig = {}): Db {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString) || connectionString.includes("host=/");
  return new pg.Pool({
    connectionString,
    // Managed Postgres (e.g. Azure Flexible Server) requires TLS; a local one usually has none.
    ssl: local ? false : { rejectUnauthorized: false },
    max: 10,
    ...options,
  });
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Finds db/migrations by walking up from this file (works from src/ and dist/src/). */
function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "db", "migrations");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Could not find db/migrations; set MIGRATIONS_DIR");
}

/** Applies any db/migrations/*.sql files not yet recorded in schema_migrations, in name order. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  await withTransaction(db, async (tx) => {
    // Serialise concurrent migrators (e.g. two API instances starting at once).
    await tx.query("SELECT pg_advisory_xact_lock(724501)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const done = new Set((await tx.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      log(`applying ${file}`);
      await tx.query(await readFile(join(dir, file), "utf8"));
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }
  });
  return applied;
}
