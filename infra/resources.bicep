param location string
param tags object
param resourceToken string
@secure()
param postgresAdminPassword string
param googleClientId string
@secure()
param anthropicApiKey string
@secure()
param googlePlacesApiKey string
@secure()
param azureMapsKey string
param recipeModel string
@description('Whether the API container app already exists (azd sets this), so re-provisioning keeps its image.')
param apiExists bool

var postgresAdminLogin = 'familyadmin'
var databaseName = 'mealplanner'
var apiName = 'ca-api-${resourceToken}'
var hasAnthropicKey = !empty(anthropicApiKey)
var hasGooglePlacesKey = !empty(googlePlacesApiKey)
var hasAzureMapsKey = !empty(azureMapsKey)

// ---------- PostgreSQL Flexible Server ----------
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'pg-${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    highAvailability: { mode: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
  }

  resource db 'databases' = {
    name: databaseName
  }

  // 0.0.0.0 means "any Azure service", which lets the API connect.
  resource allowAzure 'firewallRules' = {
    name: 'AllowAllAzureServices'
    properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
  }
}

// ---------- Web: Static Web App ----------
resource web 'Microsoft.Web/staticSites@2024-04-01' = {
  name: 'swa-${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

// ---------- API: Container Apps ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'cr${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// The container app pulls its image from the registry as this identity.
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-api-${resourceToken}'
  location: location
  tags: tags
}

var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource apiAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, apiIdentity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// On the first provision the app runs a placeholder image until `azd deploy` pushes the real one.
module apiImage 'fetch-container-image.bicep' = {
  name: 'api-image'
  params: { exists: apiExists, name: apiName }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiName
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${apiIdentity.id}': {} }
  }
  dependsOn: [apiAcrPull]
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      registries: [{ server: registry.properties.loginServer, identity: apiIdentity.id }]
      secrets: concat(
        [
          {
            name: 'database-url'
            value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}'
          }
        ],
        // Container Apps rejects an empty secret, so only add it when set.
        hasAnthropicKey ? [{ name: 'anthropic-api-key', value: anthropicApiKey }] : [],
        hasGooglePlacesKey ? [{ name: 'google-places-api-key', value: googlePlacesApiKey }] : [],
        hasAzureMapsKey ? [{ name: 'azure-maps-key', value: azureMapsKey }] : []
      )
    }
    template: {
      containers: [
        {
          name: 'api'
          image: empty(apiImage.outputs.image) ? 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest' : apiImage.outputs.image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(
            [
              { name: 'DATABASE_URL', secretRef: 'database-url' }
              { name: 'PORT', value: '8080' }
              { name: 'WEB_ORIGIN', value: 'https://${web.properties.defaultHostname}' }
              { name: 'GOOGLE_CLIENT_ID', value: googleClientId }
              { name: 'RECIPE_MODEL', value: recipeModel }
              { name: 'MIGRATE_ON_START', value: 'true' }
            ],
            hasAnthropicKey ? [{ name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }] : [],
            hasGooglePlacesKey ? [{ name: 'GOOGLE_PLACES_API_KEY', secretRef: 'google-places-api-key' }] : [],
            hasAzureMapsKey ? [{ name: 'AZURE_MAPS_KEY', secretRef: 'azure-maps-key' }] : []
          )
        }
      ]
      // Scales to zero when idle; the first request after that takes a few seconds.
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
}

output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output webUrl string = 'https://${web.properties.defaultHostname}'
output registryEndpoint string = registry.properties.loginServer
