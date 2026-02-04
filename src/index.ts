import * as pulumi from '@pulumi/pulumi'
import {
  GitHubOrganizationComponent,
  GitHubConfig,
  BufConfig,
  GitHubRepositoryComponent,
  RepositoryName,
  Environment,
} from './github/index.js'
import { Gcp } from './gcp/index.js'
import { GcpConfig } from './gcp/components/project.js'

const brandId = 'liverty-music'
const displayName = 'Liverty Music'

const config = new pulumi.Config('liverty-music')
const githubConfig = config.requireObject('github') as GitHubConfig
const gcpConfig = config.requireObject('gcp') as GcpConfig
const bufConfig = config.requireObject('buf') as BufConfig

const env = pulumi.getStack() as Environment

// 1. GitHub Organization Configuration (Prod Only)
if (env === 'prod') {
  new GitHubOrganizationComponent({
    brandId,
    displayName,
    githubConfig: {
      ...githubConfig,
      geminiApiKey: gcpConfig.geminiApiKey,
    },
    bufConfig,
  })
}

// 2. GCP Infrastructure (All Environments)
const gcp = new Gcp({
  brandId,
  displayName,
  environment: env,
  gcpConfig,
})

// 3. GitHub Repository Environments (All Environments)
new GitHubRepositoryComponent({
  brandId,
  githubConfig,
  repositoryName: RepositoryName.BACKEND,
  environment: env,
  variables: {
    REGION: gcp.region,
    PROJECT_ID: gcp.projectId,
    WORKLOAD_IDENTITY_PROVIDER: gcp.githubWorkloadIdentityProvider,
    SERVICE_ACCOUNT: gcp.githubActionsSAEmail,
  },
})

// Export common resources
export const folder = gcp.folder
export const project = gcp.project
// Export for debug/reference
export const githubEnv = env
