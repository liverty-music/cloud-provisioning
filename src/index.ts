import * as gcp from '@pulumi/gcp'
import { getEnvironmentConfig } from './config/index.js'
import { FOLDER_NAME } from './config/constants.js'

const organizationId = process.env.GCP_ORGANIZATION_ID
if (!organizationId) {
  throw new Error('The GCP_ORGANIZATION_ID environment variable must be set.')
}

const billingAccount = process.env.GCP_BILLING_ACCOUNT
if (!billingAccount) {
  throw new Error('The GCP_BILLING_ACCOUNT environment variable must be set.')
}

const envConfig = getEnvironmentConfig('pannpers-scaffold')

export const folder = new gcp.organizations.Folder(FOLDER_NAME, {
  displayName: FOLDER_NAME,
  parent: `organizations/${organizationId}`,
})

export const project = new gcp.organizations.Project(`${envConfig.projectId}`, {
  projectId: `${envConfig.projectId}`,
  name: `Scaffold ${envConfig.environment.toUpperCase()} Environment`,
  folderId: folder.folderId,
  billingAccount: billingAccount,
  deletionPolicy: 'DELETE',
})

export const enabledServices = envConfig.enabledApis.map(
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
