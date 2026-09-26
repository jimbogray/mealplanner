#!/bin/sh
# Assembles api/.deploy: the compiled API, shared and migrations, run with
# `node api/dist/src/server.js` after `npm install --omit=dev`. Used by the Dockerfile.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/api/.deploy"

cd "$root"
npm run build --workspace shared
npm run build --workspace api

rm -rf "$out"
mkdir -p "$out/api/dist" "$out/db"
cp -R "$root/api/dist/src" "$out/api/dist/src"
# The API finds db/migrations by walking up from api/dist/src.
cp -R "$root/db/migrations" "$out/db/migrations"

# The shared workspace goes in as a local file: dependency.
mkdir -p "$out/shared"
cp -R "$root/shared/package.json" "$root/shared/dist" "$out/shared/"
node -e '
  const api = require(process.argv[1]);
  const deps = { ...api.dependencies, "@mealplanner/shared": "file:./shared" };
  const pkg = { name: "family-api", private: true, type: "module", engines: { node: ">=20.12" }, dependencies: deps };
  require("fs").writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + "\n");
' "$root/api/package.json" "$out/package.json"
