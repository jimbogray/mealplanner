@description('Location for all resources.')
param location string
param tags object
param prefix string
param resourceToken string
param postgresAdminLogin string
@secure()
param postgresAdminPassword string

// ---------- Observability ----------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// ---------- Storage (required by Functions) ----------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'st${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

// ---------- PostgreSQL Flexible Server (+ pgvector) ----------
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: '${prefix}-pg'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    highAvailability: { mode: 'Disabled' }
    backup: { backupRetentionDays: 7 }
  }

  resource db 'databases@2023-06-01-preview' = {
    name: 'mealplanner'
  }

  // Allow other Azure services (the Function App) to connect.
  resource allowAzure 'firewallRules@2023-06-01-preview' = {
    name: 'AllowAllAzureServices'
    properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
  }

  // Allow-list pgvector so 001_init.sql can CREATE EXTENSION vector.
  resource extensions 'configurations@2023-06-01-preview' = {
    name: 'azure.extensions'
    properties: { value: 'VECTOR,PGCRYPTO', source: 'user-override' }
  }
}

// ---------- Azure OpenAI ----------
resource openai 'Microsoft.CognitiveServices/accounts@2024-06-01-preview' = {
  name: '${prefix}-openai'
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: '${prefix}-openai'
    publicNetworkAccess: 'Enabled'
  }
}

resource chatDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-06-01-preview' = {
  parent: openai
  name: 'gpt-4o-mini'
  sku: { name: 'GlobalStandard', capacity: 20 }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-4o-mini', version: '2024-07-18' }
  }
}

resource embedDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-06-01-preview' = {
  parent: openai
  name: 'text-embedding-3-small'
  dependsOn: [ chatDeployment ]  // deployments must be created serially
  sku: { name: 'Standard', capacity: 20 }
  properties: {
    model: { format: 'OpenAI', name: 'text-embedding-3-small', version: '1' }
  }
}

// ---------- Azure Communication Services (SMS) ----------
resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: '${prefix}-acs'
  location: 'global'
  tags: tags
  properties: {
    dataLocation: 'United Kingdom'
  }
}

// ---------- Function App (Consumption, Linux, Node 20) ----------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${prefix}-plan'
  location: location
  tags: tags
  sku: { name: 'Y1', tier: 'Dynamic' }
  properties: { reserved: true }
}

var storageConn = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: '${prefix}-api'
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|20'
      cors: { allowedOrigins: [ 'https://portal.azure.com' ] }
      appSettings: [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'AzureWebJobsStorage', value: storageConn }
        { name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING', value: storageConn }
        { name: 'WEBSITE_CONTENTSHARE', value: toLower('${prefix}-api') }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'DATABASE_URL', value: 'postgres://${postgresAdminLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/mealplanner?sslmode=require' }
        { name: 'ACS_CONNECTION_STRING', value: acs.listKeys().primaryConnectionString }
        { name: 'AZURE_OPENAI_ENDPOINT', value: openai.properties.endpoint }
        { name: 'AZURE_OPENAI_API_KEY', value: openai.listKeys().key1 }
        { name: 'AZURE_OPENAI_CHAT_DEPLOYMENT', value: chatDeployment.name }
        { name: 'AZURE_OPENAI_EMBED_DEPLOYMENT', value: embedDeployment.name }
        { name: 'WEB_SEARCH_PROVIDER', value: 'none' }
      ]
    }
  }
}

// ---------- Static Web App (frontend) ----------
resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    // The Function App is linked as the SWA backend so /api/* is authenticated by SWA.
    buildProperties: {}
  }
}

resource swaBackend 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: staticWebApp
  name: 'api'
  properties: {
    backendResourceId: functionApp.id
    region: location
  }
}

output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output openAiEndpoint string = openai.properties.endpoint
output acsEndpoint string = acs.properties.hostName
