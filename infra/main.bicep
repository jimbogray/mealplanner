// One-time setup of everything the deploy workflows need in Azure:
//   rg-mealplanner-shared      container registry (one image, promoted from staging to production)
//   rg-mealplanner-staging     staging environment
//   rg-mealplanner-production  production environment
// Each environment gets Postgres, the API on Container Apps, a migration job, a Static Web App
// for the web app, and a managed identity GitHub Actions signs in as (OIDC, no stored secrets).
//
// Deploy with:  az deployment sub create -l uksouth -f infra/main.bicep -p infra/main.bicepparam
// See infra/README.md.
targetScope = 'subscription'

@description('Azure region for everything except the Static Web Apps.')
param location string = 'uksouth'

@description('Static Web Apps are only offered in a few regions (westeurope, eastus2, centralus, westus2, eastasia).')
param staticWebAppLocation string = 'westeurope'

@description('GitHub repository (owner/name) whose "staging" and "production" environments may deploy.')
param githubRepo string = 'jimbogray/mealplanner'

@description('Administrator login for both Postgres servers.')
param postgresAdminLogin string = 'mpadmin'

@secure()
@description('Administrator password for the staging Postgres server.')
param stagingPostgresPassword string

@secure()
@description('Administrator password for the production Postgres server.')
param productionPostgresPassword string

var environments = [
  {
    name: 'staging'
    postgresPassword: stagingPostgresPassword
    minReplicas: 0
  }
  {
    name: 'production'
    postgresPassword: productionPostgresPassword
    minReplicas: 1
  }
]

// Built-in role ids.
var acrPullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPushRole = '8311e382-0749-4cb8-b61a-304f252e45ec'

resource sharedRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-mealplanner-shared'
  location: location
}

module shared 'modules/shared.bicep' = {
  name: 'mealplanner-shared'
  scope: sharedRg
  params: {
    location: location
  }
}

resource envRgs 'Microsoft.Resources/resourceGroups@2024-03-01' = [
  for env in environments: {
    name: 'rg-mealplanner-${env.name}'
    location: location
  }
]

module envs 'modules/environment.bicep' = [
  for (env, i) in environments: {
    name: 'mealplanner-${env.name}'
    scope: envRgs[i]
    params: {
      environmentName: env.name
      location: location
      staticWebAppLocation: staticWebAppLocation
      githubRepo: githubRepo
      acrLoginServer: shared.outputs.acrLoginServer
      postgresAdminLogin: postgresAdminLogin
      postgresAdminPassword: env.postgresPassword
      minReplicas: env.minReplicas
    }
  }
]

// The API and migration job in each environment pull images with their own identity.
module acrPull 'modules/acr-role.bicep' = [
  for (env, i) in environments: {
    name: 'mealplanner-acrpull-${env.name}'
    scope: sharedRg
    params: {
      acrName: shared.outputs.acrName
      principalId: envs[i].outputs.apiPrincipalId
      roleDefinitionId: acrPullRole
    }
  }
]

// Only the staging workflow builds and pushes images; production reuses the one on staging.
module acrPush 'modules/acr-role.bicep' = {
  name: 'mealplanner-acrpush-staging'
  scope: sharedRg
  params: {
    acrName: shared.outputs.acrName
    principalId: envs[0].outputs.githubPrincipalId
    roleDefinitionId: acrPushRole
  }
}

output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output ACR_NAME string = shared.outputs.acrName
output staging object = {
  AZURE_CLIENT_ID: envs[0].outputs.githubClientId
  AZURE_RESOURCE_GROUP: envRgs[0].name
  apiUrl: envs[0].outputs.apiUrl
  webUrl: envs[0].outputs.webUrl
}
output production object = {
  AZURE_CLIENT_ID: envs[1].outputs.githubClientId
  AZURE_RESOURCE_GROUP: envRgs[1].name
  apiUrl: envs[1].outputs.apiUrl
  webUrl: envs[1].outputs.webUrl
}
