import * as pulumi from '@pulumi/pulumi'
import { GitHubComponent, GitHubConfig, BufConfig } from './github/index.js'
import { Gcp } from './gcp/index.js'
import { GcpConfig } from './gcp/components/project.js'

const brandId = 'liverty-music'
const displayName = 'Liverty Music'

const config = new pulumi.Config('liverty-music')
const githubConfig = config.requireObject('github') as GitHubConfig
const gcpConfig = config.requireObject('gcp') as GcpConfig
const bufConfig = config.requireObject('buf') as BufConfig

export type Environment = 'dev' | 'staging' | 'prod'
const env = pulumi.getStack() as Environment

// 1. GitHub Configuration (Prod Only)
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

// 2. GCP Infrastructure (All Environments)
const gcp = new Gcp({
  brandId,
  displayName,
  environment: env,
  gcpConfig,
})

// Export common resources
export const folder = gcp.folder
export const project = gcp.project
