# Family app

A simple starting point: someone signs up and creates a **family**, then invites the
rest of the family with a shareable link. Every family member has a **life stage**
(baby, toddler, child, teenager or adult), a **diet** (no restriction, vegetarian or
vegan) and any **allergies** from the UK's 14 major food allergens. Admins can add
members whether or not they'll ever sign in, and later send an added member a link to
sign in as themselves.

The earlier meal-planning code (fridge inventory, SMS poll, AI recipes) is parked in
[`legacy/`](legacy/NOTE.md).

## Architecture

| Part | What | Where it runs |
|---|---|---|
| `web/` | React + Vite single-page app, built to static files | any static host (e.g. Azure Static Web Apps) |
| `api/` | Plain Node.js + TypeScript HTTP API (`node:http` + `pg`, no framework) | any Node host (App Service, Container Apps, a VM…) |
| `db/migrations/` | PostgreSQL schema, applied in order by the API | PostgreSQL 13+ |
| `shared/` | Types and the list of life stages, used by both | — |

The API is a standalone Node server rather than Azure Functions so it runs the same
everywhere (locally, in CI, in a container) without the Functions host.

### Data model

- `app_user`: a login: email plus a scrypt password hash, a linked Google account, or both.
- `family`: a family, with a name.
- `family_member`: a person in a family, with `name`, `life_stage`, `diet`, `allergies`
  and `role` (`admin` or `member`). `user_id` is set only for people with their own login.
- `invite`: a one-time invite code for a family, valid for 14 days. If `member_id` is set,
  accepting it gives that existing member a login instead of adding a new member.
- `session`: sign-in tokens (only their SHA-256 hash is stored).

### Who can do what

- The person who creates a family is its **admin** (shown as "Family Manager"; adding someone as a "Co-Manager" makes them an admin too). Admins can add, edit and remove
  members, make other members with a login admins, and create or revoke invite links.
- Everyone can edit their own name, life stage, diet and allergies, and leave the family.
- A family always keeps at least one admin.

## API

All JSON. Signed-in calls send `Authorization: Bearer <token>`.

| Method & path | Who | Does |
|---|---|---|
| `POST /api/auth/signup` | anyone | `{email, password, name, lifeStage, familyName}` creates a family, or `{…, inviteCode}` joins one (`name`/`lifeStage` not needed for a member invite). Returns `{token, me}`. |
| `POST /api/auth/login` | anyone | `{email, password}` → `{token, me}` |
| `POST /api/auth/google/redirect` | Google | Google's redirect-mode form post; sends the token on to the web app's `/auth/google#credential=…`. |
| `POST /api/auth/google` | anyone | `{credential}` (a Google ID token) signs in. To sign up, add `lifeStage` and `familyName` or `inviteCode` (`name` defaults to the Google name). |
| `POST /api/auth/logout` | signed in | ends the session |
| `GET /api/me` | signed in | you, your family and its members |
| `POST /api/family` | signed in, no family | `{familyName, name, lifeStage}` starts a family |
| `PATCH /api/family` | admin | `{name}` renames the family |
| `POST /api/family/members` | admin | `{name, lifeStage, diet?, allergies?}` adds a member without a login |
| `PATCH /api/family/members/:id` | admin, or yourself | `{name?, lifeStage?, diet?, allergies?, role?}` (role: admins only) |
| `DELETE /api/family/members/:id` | admin, or yourself | removes a member / leaves |
| `GET /api/family/invites` | admin | open invites |
| `POST /api/family/invites` | admin | creates an invite → `{code, expiresAt, …}`; `{memberId}` makes it an invite for that existing member to sign in as themselves |
| `DELETE /api/family/invites/:id` | admin | revokes an invite |
| `GET /api/invites/:code` | anyone | family name and inviter, for the join page |
| `POST /api/invites/:code/accept` | signed in, no family | `{name, lifeStage}` joins the family |
| `GET /api/family/weeks` | family member | the weekly schedule: weeks (Monday to Sunday), each day with who's joining for dinner and guests |
| `POST /api/family/weeks` | family member | `{startsOn, today, days?}` adds this week (if missing, from today) or the week after the last one; without `days`, every day is planned with everyone joining, no guests; with `days`, only those days |
| `PATCH /api/family/weeks/:startsOn/days/:date` | family member | `{memberIds, guests}` changes one day, or `{eatOut: true}` marks it as eating out (no one joining, no guests) |
| `DELETE /api/family/weeks/:startsOn/days/:date` | family member | takes a day out of the schedule (a week keeps at least one); `PATCH` adds it back |
| `DELETE /api/family/weeks/:startsOn` | family member | removes a week |
| `GET /api/health` | anyone | checks the database connection |

## Local development

Needs Node 20.12+ and PostgreSQL 13+.

```bash
npm install

# 1. A database (Docker, or any local Postgres)
docker run -d --name family-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mealplanner -p 5432:5432 postgres:16

# 2. Configure and start the API (applies migrations on start-up)
cp api/.env.example api/.env
npm run build --workspace shared
npm run dev:api             # http://localhost:8080

# 3. Start the web app in another terminal
npm run dev:web             # http://localhost:5173 (proxies /api to :8080)
```

Open http://localhost:5173, create a family, then use **Create invite link** and open the
link in a private window to join as someone else.

### Tests

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/mealplanner npm test
```

The API tests run against a real Postgres in a throwaway schema (they're skipped if
`TEST_DATABASE_URL` isn't set). CI runs them against a Postgres 16 service.

### Sign in with Google (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an
   **OAuth client ID** of type *Web application*.
2. Under **Authorised JavaScript origins**, add each web app URL (e.g. `http://localhost:5173`
   and your production URL). Under **Authorised redirect URIs**, add each API's
   `/api/auth/google/redirect` (e.g. `http://localhost:5173/api/auth/google/redirect` locally,
   via the dev proxy, and `https://<api-host>/api/auth/google/redirect` in production).
   Most browsers use a popup; iPhones and iPads use Google's full-page redirect instead,
   because Safari there often loses the popup's result.
3. Set the client id as `GOOGLE_CLIENT_ID` for the API and `VITE_GOOGLE_CLIENT_ID` for the web
   app. Without them the Google button is hidden and `/api/auth/google` returns 404.

The API verifies Google's ID token itself (signature against Google's published keys,
issuer, audience, expiry, verified email). A Google sign-in whose email matches an existing
account is linked to that account.

### Favourite recipes read by Claude (optional)

When someone adds a recipe to the Library page by its link, the API downloads the page and asks Claude
(`claude-haiku-4-5` by default, the cheapest current model; override with `RECIPE_MODEL`) for
the dish's name, a short description, the approximate cooking time and the main protein. The
photo is the page's own share image, or else the page photo Claude judges best shows the dish;
its URL is stored (the image itself isn't copied). If the
page doesn't look like a recipe, the web app asks whether to add it anyway and has the person
type in whatever couldn't be read.

Set `ANTHROPIC_API_KEY` for the API (create one at
[console.anthropic.com](https://console.anthropic.com/settings/keys)). Without it, recipes can
still be added: the name and photo come from the page's metadata and the rest is typed in.
Pages on private or loopback addresses are never fetched.

### Home address search (optional)

A Family Manager adds the family's home address on the Family page by typing into one search
box and picking their address from Google's suggestions (US street addresses only, stored as street, city, state and ZIP code). Its latitude and
longitude are stored too, for restaurant driving times. The API calls
[Places API (New)](https://developers.google.com/maps/documentation/places/web-service/op-overview)
itself (Autocomplete, then Place Details for the pick, in one billing session), so the key never
reaches the browser.

Set `GOOGLE_PLACES_API_KEY` for the API: in the Google Cloud console, enable **Places API (New)**
on a project with billing, create an API key under *APIs & Services > Credentials*, and restrict it
to that API. Without the key, the Family page says address search isn't set up.

### Restaurant driving times (optional)

With `AZURE_MAPS_KEY` set on the API, adding a restaurant finds it on the map (by the address
typed in, or else by its name near home) and, when the family has a home address, stores the
driving time from home. Create an Azure Maps account in the Azure portal and copy its primary
key from Authentication; the free monthly allowance is far more than a family uses. A home
address typed in without coordinates is found on the map too. Without the key, restaurants
have no driving time.

### Restaurant details from their link (optional)

With `ANTHROPIC_API_KEY` set (the same key and model as recipe reading), adding a restaurant with
a link has Claude read that page for the type of cuisine, the address and a link for booking a
table (OpenTable, ResDiary and so on). It only fills in what was left blank, and a booking link
is kept only if it really is on the page. The address it finds is then used for the driving time.

With `GOOGLE_PLACES_API_KEY` set (the key used for the home address), the restaurant's address box
suggests places as you type (restaurant names, streets or ZIP codes), nearest home first. Picking
one saves its exact location, so the driving time needs no further map lookup.

## Deploying

### To Azure with azd

`infra/` (Bicep) and `azure.yaml` create a Container App for the API (image built from the
root `Dockerfile` in a Basic container registry; scales to zero when idle), a Static Web App
for the web app, and a PostgreSQL 16 Flexible Server (Burstable B1ms), all in resource group
`rg-<env>`. Needs the [Azure Developer CLI](https://aka.ms/azd); on Apple Silicon, also
Rosetta (`softwareupdate --install-rosetta`), because the Static Web Apps deploy tool is
Intel-only.

```bash
azd auth login              # or: azd config set auth.useAzCliAuth true
azd env new family-prod --location eastus2
azd env set POSTGRES_ADMIN_PASSWORD "$(openssl rand -hex 24)"
azd env set GOOGLE_CLIENT_ID <client-id>   # optional
azd env set ANTHROPIC_API_KEY <key>        # optional, for reading recipe pages
azd env set GOOGLE_PLACES_API_KEY <key>  # optional, for searching for the home address
azd env set AZURE_MAPS_KEY <key>           # optional, for restaurant driving times
azd provision
azd deploy
```

Provision and deploy separately the first time: the web app is built with the API's URL
(`VITE_API_URL`, a Bicep output), and `azd up` packages it before provisioning finishes.
After that, `azd up` or `azd deploy` both work. The API's allowed origin (`WEB_ORIGIN`) is
wired up in the Bicep. For Google sign-in, add the `SERVICE_WEB_ENDPOINT` URL
(`azd env get-values`) to the OAuth client's authorised origins, and
the `SERVICE_API_ENDPOINT` URL plus `/api/auth/google/redirect` to its authorised redirect URIs.

### From GitHub Actions

**Deploy to production** (`.github/workflows/azure-dev.yml`) runs CI and then the same
`azd provision` and `azd deploy` against the production azd environment. Start it from the
repo's **Actions** tab → *Deploy to production* → *Run workflow* (on `main`). It never runs
by itself.

One-time setup, from a machine where `azd deploy` already works for `family-prod`:

```bash
azd pipeline config -e family-prod --provider github --auth-type federated
```

This creates a service principal that GitHub signs in as (OIDC, no stored password) with a
federated credential for `main`, gives it access to the subscription, and sets the repo's
Actions variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_ENV_NAME`, `AZURE_LOCATION`, `GOOGLE_CLIENT_ID`, `RECIPE_MODEL`) and secrets
(`POSTGRES_ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY`, `AZURE_MAPS_KEY`) from your local azd environment, as listed
under `pipeline:` in `azure.yaml`. If it offers to push, say no and merge the workflow
through a pull request instead. Re-run it after changing any of those values locally.

### Elsewhere

- **Database**: any managed PostgreSQL (e.g. Azure Database for PostgreSQL Flexible Server).
- **API**: `npm ci && npm run build --workspace shared && npm run build --workspace api`,
  then `node api/dist/src/server.js` with `DATABASE_URL`, `PORT`, `WEB_ORIGIN` (the web
  app's URL, for CORS) and optionally `GOOGLE_CLIENT_ID`, `ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY` and `AZURE_MAPS_KEY` set.
- **Web**: `VITE_API_URL=https://<api-host> VITE_GOOGLE_CLIENT_ID=<id> npm run build --workspace web` and upload
  `web/dist` to a static host. `web/public/staticwebapp.config.json` (copied into `dist`) makes deep links like
  `/join/<code>` work on Azure Static Web Apps.

## Not done yet

- Invites are links to share by hand; no email is sent.
- No password reset or email verification.
- No rate limiting on sign-in.
