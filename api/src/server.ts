import { createApp } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { createPool, migrate } from "./db.js";
import { googleKeySource } from "./google.js";

loadDotEnv();
const config = loadConfig();
const db = createPool(config.databaseUrl);

if (config.migrateOnStart) {
  const applied = await migrate(db, (msg) => console.log(`[migrate] ${msg}`));
  if (applied.length) console.log(`[migrate] applied ${applied.length} migration(s)`);
}

const server = createApp(db, {
  webOrigins: config.webOrigins,
  google: config.googleClientId ? { clientId: config.googleClientId, keys: googleKeySource() } : undefined,
});
server.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port} (web origins: ${config.webOrigins.join(", ")}; Google sign-in ${config.googleClientId ? "on" : "off"})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void db.end().then(() => process.exit(0)));
  });
}
