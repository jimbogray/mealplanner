// CLI: apply pending migrations to DATABASE_URL.  npm run db:migrate
import { loadDotEnv } from "./config.js";
import { createPool, migrate } from "./db.js";

loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const db = createPool(url);
try {
  const applied = await migrate(db, (msg) => console.log(msg));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
} finally {
  await db.end();
}
