using './main.bicep'

// Passwords are read from environment variables so they never land in the repo:
//   export STAGING_PG_PASSWORD='...' PRODUCTION_PG_PASSWORD='...'
param stagingPostgresPassword = readEnvironmentVariable('STAGING_PG_PASSWORD')
param productionPostgresPassword = readEnvironmentVariable('PRODUCTION_PG_PASSWORD')
