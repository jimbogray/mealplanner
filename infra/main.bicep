targetScope = 'subscription'

@minLength(1)
@description('Name of the azd environment; used to derive resource names.')
param environmentName string

@minLength(1)
@description('Primary location for all resources.')
param location string

@secure()
@description('Admin password for the PostgreSQL flexible server.')
param postgresAdminPassword string

@description('Administrator login for PostgreSQL.')
param postgresAdminLogin string = 'mpadmin'

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var prefix = 'mp-${environmentName}'
var tags = { 'azd-env-name': environmentName }

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    location: location
    tags: tags
    prefix: prefix
    resourceToken: resourceToken
    postgresAdminLogin: postgresAdminLogin
    postgresAdminPassword: postgresAdminPassword
  }
}

output AZURE_LOCATION string = location
output SERVICE_API_ENDPOINT string = resources.outputs.functionAppUrl
output SERVICE_WEB_ENDPOINT string = resources.outputs.staticWebAppUrl
output AZURE_OPENAI_ENDPOINT string = resources.outputs.openAiEndpoint
output ACS_ENDPOINT string = resources.outputs.acsEndpoint
