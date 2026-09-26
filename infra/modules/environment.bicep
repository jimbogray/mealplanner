// One environment (staging or production), deployed into its own resource group.
param environmentName string
param location string
param staticWebAppLocation string
param githubRepo string
param acrLoginServer string
param postgresAdminLogin string
@secure()
param postgresAdminPassword string
param minReplicas int

// The deploy workflows replace this with the real API image; re-running this template
// puts it back, so run the staging deploy (or promote) again afterwards.
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var token = uniqueString(resourceGroup().id)
var contributorRole = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

// --- Identities -----------------------------------------------------------------------------

// Used by the API and migration job to pull images from the registry.
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-mealplanner-api'
  location: location
}

// GitHub Actions signs in as this identity from the matching GitHub environment only.
resource githubIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-mealplanner-github-${environmentName}'
  location: location
}

resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: githubIdentity
  name: 'github-${environmentName}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepo}:environment:${environmentName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource githubContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, githubIdentity.id, contributorRole)
  properties: {
    principalId: githubIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRole)
  }
}

// --- Database -------------------------------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-mealplanner-${environmentName}-${token}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// Lets Container Apps reach the server (0.0.0.0 means "Azure services"); connections still
// need the password and TLS.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'mealplanner'
}

// The API turns on TLS itself for non-local hosts, so no sslmode in the URL.
var databaseUrl = 'postgres://${uriComponent(postgresAdminLogin)}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${database.name}'

// --- Web app --------------------------------------------------------------------------------

resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'swa-mealplanner-${environmentName}'
  location: staticWebAppLocation
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

var webOrigin = 'https://${web.properties.defaultHostname}'

// --- API and migration job ------------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-mealplanner-${environmentName}'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-mealplanner-${environmentName}'
  location: location
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

var registries = [
  {
    server: acrLoginServer
    identity: apiIdentity.id
  }
]
var secrets = [
  {
    name: 'database-url'
    value: databaseUrl
  }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-mealplanner-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${apiIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      registries: registries
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: placeholderImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'PORT', value: '8080' }
            { name: 'WEB_ORIGIN', value: webOrigin }
            // Migrations run as a separate step of each deploy (the job below).
            { name: 'MIGRATE_ON_START', value: 'false' }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 3
      }
    }
  }
}

resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-mealplanner-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${apiIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registries
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: placeholderImage
          command: ['node', 'api/dist/src/migrate.js']
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
          ]
        }
      ]
    }
  }
}

output githubClientId string = githubIdentity.properties.clientId
output githubPrincipalId string = githubIdentity.properties.principalId
output apiPrincipalId string = apiIdentity.properties.principalId
output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output webUrl string = webOrigin
