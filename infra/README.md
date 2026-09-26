# Deploying to Azure

Two GitHub Actions workflows deploy the app to two separate Azure environments:

| Workflow | When | Does |
|---|---|---|
| **Deploy to staging** (`.github/workflows/deploy-staging.yml`) | every push to `main` (or run it by hand) | runs CI, builds the API image and the web app once, runs database migrations, deploys to **staging** |
| **Promote to production** (`.github/workflows/promote-production.yml`) | run by hand from the Actions tab | takes the image and web build from a successful staging deploy (the latest one by default), waits for approval, runs migrations and deploys them to **production** |

Nothing is rebuilt on promotion: production runs the same API image (by digest) and the same
web files that were tested on staging. The web build is made with placeholder values for
`VITE_API_URL` and `VITE_GOOGLE_CLIENT_ID`, and each deploy fills in that environment's values.

GitHub signs in to Azure with OpenID Connect (a federated credential per GitHub environment),
so no Azure passwords or keys are stored in GitHub.

## What runs where

Each environment has its own resource group (`rg-mealplanner-staging`, `rg-mealplanner-production`):

| Resource | Name | For |
|---|---|---|
| Azure Database for PostgreSQL Flexible Server (B1ms, v16) | `psql-mealplanner-<env>-<suffix>` | the database `mealplanner` |
| Container Apps environment + Container App | `ca-mealplanner-api` | the API (`infra/api.Dockerfile`), port 8080 |
| Container Apps job | `caj-mealplanner-migrate` | runs `db/migrations` with the same image before each API deploy |
| Static Web App (Free) | `swa-mealplanner-<env>` | the web app |
| Log Analytics workspace | `log-mealplanner-<env>` | API and job logs |
| Managed identity | `id-mealplanner-api` | lets the API and job pull images |
| Managed identity + federated credential | `id-mealplanner-github-<env>` | what GitHub Actions signs in as (Contributor on the resource group) |

`rg-mealplanner-shared` holds one Azure Container Registry (`crmealplanner<suffix>`) used by both.
Only the staging GitHub identity can push to it.

All of this is in `infra/main.bicep`. Rough cost at the default sizes is about US$40–60 a month,
mostly the two Postgres servers and production's always-on API replica.

## One-time setup

### 1. Create the Azure resources

You need an Azure subscription where you are **Owner** (the template creates role assignments),
and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).

```bash
az login
az account set --subscription "<your subscription>"

# Once per subscription
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.Web \
          Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace $ns
done

# Choose two strong Postgres passwords (keep them somewhere safe)
export STAGING_PG_PASSWORD='...' PRODUCTION_PG_PASSWORD='...'

az deployment sub create --name mealplanner --location uksouth \
  --template-file infra/main.bicep --parameters infra/main.bicepparam \
  --query properties.outputs
```

Change `location` (default `uksouth`) or `staticWebAppLocation` (default `westeurope`) with
`--parameters location=...` if you want another region. The outputs list every value
step 2 needs.

### 2. Set up GitHub

In the repository's **Settings → Environments**, create two environments:

- **staging**: under *Deployment branches and tags* choose *Selected branches* and add `main`.
- **production**: tick **Required reviewers** and add yourself; also restrict deployment
  branches to `main`.

Add these **variables** (not secrets; none of them are sensitive):

| Where | Variable | Value |
|---|---|---|
| Settings → Secrets and variables → Actions → *Variables* (repository) | `AZURE_TENANT_ID` | output `AZURE_TENANT_ID` |
| same | `AZURE_SUBSCRIPTION_ID` | output `AZURE_SUBSCRIPTION_ID` |
| same | `ACR_NAME` | output `ACR_NAME` |
| Environment **staging** → Environment variables | `AZURE_CLIENT_ID` | output `staging.AZURE_CLIENT_ID` |
| same | `AZURE_RESOURCE_GROUP` | `rg-mealplanner-staging` |
| same | `GOOGLE_CLIENT_ID` | staging's Google OAuth client id (leave unset to hide Google sign-in) |
| Environment **production** → Environment variables | `AZURE_CLIENT_ID` | output `production.AZURE_CLIENT_ID` |
| same | `AZURE_RESOURCE_GROUP` | `rg-mealplanner-production` |
| same | `GOOGLE_CLIENT_ID` | production's Google OAuth client id |

The federated credentials are already created by the template: they trust tokens for
`repo:jimbogray/mealplanner:environment:staging` and `...:environment:production`. If the repo
is renamed or moved, redeploy with `--parameters githubRepo=<owner>/<name>`.

### 3. Google sign-in

In Google Cloud Console → APIs & Services → Credentials, add each environment's web URL
(outputs `staging.webUrl`, `production.webUrl`) to the OAuth client's **Authorized JavaScript
origins**. One client for both environments is fine; then use the same `GOOGLE_CLIENT_ID` in both.

### 4. First deploy

Push to `main` or run **Deploy to staging** from the Actions tab. Then, to release, run
**Promote to production** and approve it when GitHub asks.

## Day to day

- **Merging to `main`** deploys to staging automatically; pull requests only run CI.
- **Promoting**: Actions → *Promote to production* → *Run workflow*. Leave the run id blank to
  promote what is on staging now, or paste the id of an earlier *Deploy to staging* run (from its
  URL) to roll production back to that build. Build artifacts are kept for 90 days.
- **Migrations** in `db/migrations` run on every deploy, before the new API starts, as the
  `caj-mealplanner-migrate` job. A failed migration stops the deploy with the old API still
  running. Because production is promoted from staging, migrations run on staging first. Keep them
  backwards compatible with the API version before them, since the old API serves traffic while
  they run.
- **Logs**: Azure portal → the Container App (or job) → *Log stream* / *Execution history*.

## Things to know

- Re-running `infra/main.bicep` resets the API and migration job to a placeholder image and
  drops `GOOGLE_CLIENT_ID` from the API. Run *Deploy to staging* and *Promote to production*
  again afterwards.
- Postgres accepts connections from any Azure service ("Allow Azure services" firewall rule),
  protected by the password and TLS. Private networking (VNet integration) is a later step if
  you want it.
- The database URL, including the password, is stored as a Container Apps secret.
- Custom domains: add them to the Static Web App and then add the domain to the API's
  `WEB_ORIGIN` (comma-separated) in `infra/modules/environment.bicep`.
