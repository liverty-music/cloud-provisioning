import * as pulumi from '@pulumi/pulumi'
import { GitHubComponent, GitHubConfig, BufConfig } from './components/github/index.js'
import { GcpProjectBasis, GcpConfig } from './components/gcp/index.js'
import { WorkloadIdentityFederation } from './components/gcp/workload-identity.js'
import { ConcertDataStore } from './components/gcp/concert-data-store.js'

const brandId = 'liverty-music'
const displayName = 'Liverty Music'

const config = new pulumi.Config('liverty-music')
const githubConfig = config.requireObject('github') as GitHubConfig
const gcpConfig = config.requireObject('gcp') as GcpConfig
const bufConfig = config.requireObject('buf') as BufConfig

export type Environment = 'dev' | 'staging' | 'prod'

const env = pulumi.getStack() as Environment

// Create GitHub and GCP components independently - they don't depend on each other
// Pulumi will automatically parallelize resource creation within each component
// const githubComponent = new GitHubComponent('github', {
if (env === 'prod') {
  new GitHubComponent({
    brandId,
    displayName,
    githubConfig: {
      ...githubConfig,
      geminiApiKey: gcpConfig.geminiApiKey,
    },
    bufConfig,
  })
}

const gcpComponent = new GcpProjectBasis({
  brandId,
  displayName,
  environment: env,
  gcpConfig,
})

new ConcertDataStore({
  projectId: gcpComponent.project.projectId,
  projectNumber: gcpComponent.project.number,
  region: gcpComponent.environmentConfig.region,
  enabledServices: gcpComponent.enabledServices,
})

// Create Workload Identity Federation for Pulumi Deployments and other providers
// const workloadIdentityFederation = new WorkloadIdentityFederation({
new WorkloadIdentityFederation({
  environment: env,
  projectId: gcpComponent.project.projectId,
  projectNumber: gcpComponent.project.number,
  folderId: pulumi.output(gcpComponent.folder).apply(f => f.folderId),
})

// Export resources for backwards compatibility and stack outputs
export const folder = gcpComponent.folder
export const project = gcpComponent.project
// export const enabledServices = gcpComponent.enabledServices
// export const pulumiCloudServiceAccountEmail = workloadIdentityFederation.serviceAccountEmail
