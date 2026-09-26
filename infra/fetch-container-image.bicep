// Returns the image a container app is currently running, or '' if it doesn't exist yet
// (a null module output reaches ARM with no value and breaks the deployment).
// A separate module because a template can't declare a resource and read it as `existing`.
param exists bool
param name string

resource existingApp 'Microsoft.App/containerApps@2024-03-01' existing = if (exists) {
  name: name
}

output image string = exists ? existingApp!.properties.template.containers[0].image : ''
