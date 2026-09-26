// Container registry shared by staging and production, so production runs the exact image
// that was tested on staging.
param location string

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'crmealplanner${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
