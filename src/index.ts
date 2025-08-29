import * as pulumi from '@pulumi/pulumi'
import { ENVIRONMENT_CONFIGS } from './config/index.js'
import { GitHubComponent, GitHubConfig, BufConfig } from './components/github/index.js'
import { GcpComponent, GcpConfig } from './components/gcp/index.js'

const brandId = 'liverty-music'
const displayName = 'Liverty Music'

// const organizationId = process.env.GCP_ORGANIZATION_ID
// if (!organizationId) {
//   throw new Error('The GCP_ORGANIZATION_ID environment variable must be set.')
// }

// const billingAccount = process.env.GCP_BILLING_ACCOUNT
// if (!billingAccount) {
//   throw new Error('The GCP_BILLING_ACCOUNT environment variable must be set.')
// }

// const envConfig = getEnvironmentConfig('pannpers-scaffold')

const config = new pulumi.Config('liverty-music')
const githubConfig = config.requireObject('github') as GitHubConfig
const gcpConfig = config.requireObject('gcp') as GcpConfig
const bufConfig = config.requireObject('buf') as BufConfig

const env = pulumi.getStack() as 'dev' | 'staging' | 'prod'

// Create GitHub and GCP components independently - they don't depend on each other
// Pulumi will automatically parallelize resource creation within each component
// const githubComponent = new GitHubComponent('github', {
if (env === 'prod') {
  new GitHubComponent({
    brandId,
    displayName,
    githubConfig,
    bufConfig,
  })
}

const gcpComponent = new GcpComponent({
  brandId,
  displayName,
  environment: env,
  gcpConfig,
  enabledApis: ENVIRONMENT_CONFIGS[env].apis,
})

// Export resources for backwards compatibility and stack outputs
export const folder = gcpComponent.folder
export const project = gcpComponent.project
export const enabledServices = gcpComponent.enabledServices
// export const githubProvider = githubComponent.provider
// export const repositories = githubComponent.repositories

// // Create a storage bucket in the project (example resource)
// // const bucket = new gcp.storage.Bucket(
// //   `${envConfig.environment}-scaffold-bucket`,
// //   {
// //     name: `${envConfig.projectId}-storage`,
// //     location: envConfig.region,
// //     project: project.projectId,
// //     forceDestroy: true,
// //   },
// //   { dependsOn: enabledServices }
// // )
