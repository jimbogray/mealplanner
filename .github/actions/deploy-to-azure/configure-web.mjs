// Fills the environment's values into a web build made with placeholder VITE_* values.
//   API_URL=https://... GOOGLE_CLIENT_ID=... node configure-web.mjs <dist dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const values = {
  __MEALPLANNER_API_URL__: process.env.API_URL ?? "",
  __MEALPLANNER_GOOGLE_CLIENT_ID__: process.env.GOOGLE_CLIENT_ID ?? "",
};
if (!dir || !values.__MEALPLANNER_API_URL__) {
  console.error("usage: API_URL=... [GOOGLE_CLIENT_ID=...] node configure-web.mjs <dist dir>");
  process.exit(1);
}

const found = new Set();
for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const file = join(entry.parentPath ?? entry.path, entry.name);
  let text = readFileSync(file, "utf8");
  for (const [placeholder, value] of Object.entries(values)) {
    if (!text.includes(placeholder)) continue;
    found.add(placeholder);
    text = text.replaceAll(placeholder, JSON.stringify(value).slice(1, -1));
  }
  writeFileSync(file, text);
}

// The API URL must be there, or the build wasn't made with the placeholders.
if (!found.has("__MEALPLANNER_API_URL__")) {
  console.error(`No __MEALPLANNER_API_URL__ placeholder found in ${dir}`);
  process.exit(1);
}
console.log(`Configured ${dir}: API ${values.__MEALPLANNER_API_URL__}, Google sign-in ${values.__MEALPLANNER_GOOGLE_CLIENT_ID__ ? "on" : "off"}`);
