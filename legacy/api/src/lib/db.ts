import pg from "pg";

// A single shared pool per Functions worker process.
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new pg.Pool({
      connectionString,
      // Azure Database for PostgreSQL requires TLS.
      ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 4,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

export const HOUSEHOLD_ID = () => process.env.HOUSEHOLD_ID ?? "00000000-0000-0000-0000-000000000001";
