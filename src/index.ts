import * as gcp from '@pulumi/gcp'
import { ENVIRONMENT_CONFIGS } from './config/index.js'
import * as github from '@pulumi/github'
import * as pulumi from '@pulumi/pulumi'

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

interface GithubConfig {
  owner: string
  token: string
  billingEmail: string
}

interface GcpConfig {
  organizationId: string
  billingAccount: string
}

const config = new pulumi.Config('cloud-provisioning')
const githubConfig = config.requireObject('github') as GithubConfig
const gcpConfig = config.requireObject('gcp') as GcpConfig

const githubProvider = new github.Provider('github-provider', {
  owner: brandId,
  token: githubConfig.token,
})

new github.OrganizationSettings(
  brandId,
  {
    name: displayName,
    description: displayName,
    defaultRepositoryPermission: 'read',
    billingEmail: githubConfig.billingEmail,
    // membersCanCreateRepositories: false,
    membersCanCreatePrivateRepositories: false,
    membersCanCreatePages: true,
  },
  { provider: githubProvider }
)

enum RepositoryName {
  CLOUD_PROVISIONING = 'cloud-provisioning',
  SCHEMA = 'schema',
}

const defaultRepositoryArgs: github.RepositoryArgs = {
  visibility: 'public',
  deleteBranchOnMerge: true,
  vulnerabilityAlerts: true,
}

new github.Repository(
  RepositoryName.CLOUD_PROVISIONING,
  {
    ...defaultRepositoryArgs,
    name: RepositoryName.CLOUD_PROVISIONING,
    description: 'Cloud Provisioning',
    template: {
      owner: githubConfig.owner,
      // https://github.com/pannpers/cloud-provisioning-scaffold
      repository: 'cloud-provisioning-scaffold',
    },
  },
  { provider: githubProvider }
)

new github.Repository(
  RepositoryName.SCHEMA,
  {
    ...defaultRepositoryArgs,
    name: RepositoryName.SCHEMA,
    description: 'Schema',
    template: {
      owner: githubConfig.owner,
      // https://github.com/pannpers/protobuf-scaffold
      repository: 'protobuf-scaffold',
    },
  },
  { provider: githubProvider }
)

export const folder = new gcp.organizations.Folder(brandId, {
  displayName: displayName,
  parent: `organizations/${gcpConfig.organizationId}`,
})

const env = pulumi.getStack() as 'dev' | 'staging' | 'prod'

const commonLabels = {
  environment: env,
}

export const project = new gcp.organizations.Project(`${brandId}`, {
  projectId: `${brandId}-${env}`,
  name: `${displayName} -${env}-`,
  folderId: folder.folderId,
  billingAccount: gcpConfig.billingAccount,
  deletionPolicy: 'DELETE',
  labels: commonLabels,
})

export const enabledServices = ENVIRONMENT_CONFIGS[env].apis.map(
  api =>
    new gcp.projects.Service(
      `${api.replace(/\.googleapis\.com$/, '').replace(/\./g, '-')}`,
      {
        project: project.projectId,
        service: api,
        disableOnDestroy: true,
      },
      { dependsOn: [project] }
    )
)

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
