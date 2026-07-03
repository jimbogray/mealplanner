# Family meal planner

A small Azure app that helps a family plan the evening meal:

- 🧊 **Fridge inventory** — track what food is in stock.
- 📲 **SMS attendance poll** — texts the family each afternoon ("home for dinner? Y/N") and tallies the headcount.
- 🤖 **AI recipe suggestions** — Azure OpenAI proposes dinners matched to the headcount and what's in the fridge, and can discover new ideas from the web.
- 🖥️ **Web dashboard** — manage inventory, family, and see/choose tonight's recipe.

Built with **TypeScript end-to-end** and deployed to **Azure**. See the full design in [`.claude/plans/linked-dazzling-naur.md`](.claude/plans/linked-dazzling-naur.md).

## Architecture

| Concern | Service |
|---|---|
| Frontend | React + Vite on **Azure Static Web Apps** |
| API | **Azure Functions v4 (Node)** — HTTP, timer, Event Grid triggers |
| SMS | **Azure Communication Services** |
| AI | **Azure OpenAI** (chat + embeddings) |
| Database | **Azure Database for PostgreSQL Flexible Server** + `pgvector` |
| Secrets | app settings (move to **Key Vault** for production) |
| IaC / deploy | **Bicep** via **azd** |

```
mealplanner/
  infra/    Bicep (main.bicep, resources.bicep)
  shared/   shared TypeScript domain types
  api/      Azure Functions (TS)
  web/      React SPA (Vite)
  db/        SQL schema + seed
```

## Prerequisites

This machine does **not** currently have Node.js. Install:

1. **Node.js 20 LTS** — https://nodejs.org
2. **Azure Functions Core Tools v4** — `npm i -g azure-functions-core-tools@4`
3. **Azure Developer CLI (azd)** — https://aka.ms/azd  (Azure CLI is already installed)
4. **Docker** (optional, for a local Postgres) or any local PostgreSQL 15+ with the `vector` extension.

## Local development

```bash
npm install                 # installs all workspaces

# 1. Start a local Postgres and apply the schema
#    (example with Docker)
docker run -d --name mp-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16
psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE mealplanner"
psql postgres://postgres:postgres@localhost:5432/mealplanner -f db/001_init.sql
psql postgres://postgres:postgres@localhost:5432/mealplanner -f db/002_seed.sql

# 2. Configure the API
cp api/local.settings.json.example api/local.settings.json   # then fill in ACS / OpenAI keys

# 3. Run API + web (two terminals)
npm run dev:api             # func start on :7071
npm run dev:web             # vite on :5173  (proxies /api -> :7071)
```

Open http://localhost:5173.

> Auth: locally the SWA auth headers aren't present, so the API's `isAuthenticated`
> check will 401. For local testing either run behind the SWA CLI
> (`swa start http://localhost:5173 --api-location http://localhost:7071`), which
> injects a mock principal, or temporarily relax the auth guard.

### Tests

```bash
npm run build --workspace shared
npm --workspace api run build && node --test api/dist/test/*.test.js
```

Covers the SMS reply parser and the fridge-match ranking (the two pure helpers).

## Deploy to Azure

```bash
azd auth login
azd env new mealplanner
azd env set POSTGRES_ADMIN_PASSWORD "<a-strong-password>"
azd up                      # provisions infra + deploys api & web
```

After the first deploy, one-off manual steps:

1. **Apply the DB schema** to the provisioned Postgres (`db/001_init.sql`).
2. **Buy an SMS-enabled phone number** in the Communication Services resource and set
   `ACS_FROM_NUMBER` on the Function App.
3. **Wire inbound SMS** → create an Event Grid subscription on the ACS resource for
   `Microsoft.Communication.SMSReceived` pointing at the `smsInbound` function.
4. **Configure Entra ID** app registration values (`AAD_CLIENT_ID`, `AAD_CLIENT_SECRET`)
   on the Static Web App, and assign the `admin` role to yourself.

## Build phases

Delivered so far: Phase 0 (scaffolding/IaC) + Phase 1–3 core (data model, inventory &
family CRUD, SMS attendance poll, AI suggestions, choose recipe). Remaining: richer
learning/discovery (Phase 4) and polish (Phase 5) — see the plan file.
