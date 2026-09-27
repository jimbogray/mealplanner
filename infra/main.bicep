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

@description('OAuth client id from Google Cloud Console. Empty turns Sign in with Google off.')
param googleClientId string = ''

@secure()
@description('Anthropic API key for reading recipe pages with Claude. Empty turns it off.')
param anthropicApiKey string = ''

@secure()
@description('Google Maps Platform key with Places API (New) enabled, for searching for the home address. Empty turns it off.')
param googlePlacesApiKey string = ''

@description('Claude model for reading recipe pages. Empty uses the API default.')
param recipeModel string = ''

@description('Set by azd once the API container app exists.')
param apiExists bool = false

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
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
    resourceToken: resourceToken
    postgresAdminPassword: postgresAdminPassword
    googleClientId: googleClientId
    anthropicApiKey: anthropicApiKey
    googlePlacesApiKey: googlePlacesApiKey
    recipeModel: recipeModel
    apiExists: apiExists
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output SERVICE_API_ENDPOINT string = resources.outputs.apiUrl
output SERVICE_WEB_ENDPOINT string = resources.outputs.webUrl
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryEndpoint
// Read by `vite build` when azd packages the web service.
output VITE_API_URL string = resources.outputs.apiUrl
output VITE_GOOGLE_CLIENT_ID string = googleClientId
