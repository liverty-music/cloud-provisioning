import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { Environment } from '../../index.js'

export interface IdentityComponentArgs {
  environment: Environment
  projectId: pulumi.Input<string>
  projectNumber: pulumi.Input<string>
  folderId: pulumi.Input<string>
}

export class WorkloadIdentityFederation extends pulumi.ComponentResource {
  public readonly pool: gcp.iam.WorkloadIdentityPool
  public readonly provider: gcp.iam.WorkloadIdentityPoolProvider
  public readonly serviceAccount: gcp.serviceaccount.Account
  public readonly serviceAccountEmail: pulumi.Output<string>

  private readonly PULUMI_ORG = 'pannpers'
  private readonly PULUMI_OIDC_ISSUER = 'https://api.pulumi.com/oidc'

  constructor(args: IdentityComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:WorkloadIdentityFederation', 'WorkloadIdentityFederation', args, opts)

    const { environment, projectId, projectNumber, folderId } = args

    // 1. Create Workload Identity Pool (per environment)
    // This pool is for ALL external providers.
    this.pool = new gcp.iam.WorkloadIdentityPool(
      `external-providers`,
      {
        workloadIdentityPoolId: `external-providers`,
        project: projectId,
        displayName: `Workload Identity Pool`,
        description: `Workload Identity Pool for external providers in ${environment} environment`,
      },
      { parent: this }
    )

    // 2. Create OIDC Provider for Pulumi Deployments
    this.provider = new gcp.iam.WorkloadIdentityPoolProvider(
      `pulumi-provider`,
      {
        workloadIdentityPoolId: this.pool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: 'pulumi-provider',
        project: projectId,
        displayName: 'Pulumi Deployments OIDC Provider',
        description: 'OIDC Provider for Pulumi Deployments authentication',
        attributeMapping: {
          'google.subject': 'assertion.sub',
        },
        attributeCondition: `assertion.sub.startsWith('pulumi:deploy:org:${this.PULUMI_ORG}:')`,
        oidc: {
          issuerUri: this.PULUMI_OIDC_ISSUER,
          allowedAudiences: [this.PULUMI_ORG],
        },
      },
      { parent: this, dependsOn: [this.pool] }
    )

    // 3. Create Service Account for Pulumi Deployments
    this.serviceAccount = new gcp.serviceaccount.Account(
      `pulumi-cloud`,
      {
        accountId: 'pulumi-cloud',
        project: projectId,
        displayName: 'Pulumi Deployments Service Account',
        description: 'Service Account for Pulumi Deployments to impersonate',
      },
      { parent: this }
    )

    this.serviceAccountEmail = this.serviceAccount.email

    // 4. Grant workloadIdentityUser to allow Pulumi Deployments to impersonate the SA
    new gcp.serviceaccount.IAMBinding(
      `pulumi-cloud-wif-user-binding`,
      {
        serviceAccountId: this.serviceAccount.name,
        role: 'roles/iam.workloadIdentityUser',
        members: [
          pulumi.interpolate`principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${this.pool.workloadIdentityPoolId}/*`,
        ],
      },
      { parent: this, dependsOn: [this.serviceAccount, this.pool] }
    )

    // 5. Grant owner role to the service account on the project
    new gcp.projects.IAMMember(
      `pulumi-cloud-project-owner`,
      {
        project: projectId,
        role: 'roles/owner',
        member: pulumi.interpolate`serviceAccount:${this.serviceAccount.email}`,
      },
      { parent: this, dependsOn: [this.serviceAccount] }
    )

    // 6. Grant folderViewer role to the service account on the folder
    new gcp.folder.IAMMember(
      `pulumi-cloud-folder-viewer`,
      {
        folder: folderId,
        role: 'roles/resourcemanager.folderViewer',
        member: pulumi.interpolate`serviceAccount:${this.serviceAccount.email}`,
      },
      { parent: this, dependsOn: [this.serviceAccount] }
    )

    this.registerOutputs({
      pool: this.pool,
      provider: this.provider,
      serviceAccount: this.serviceAccount,
      serviceAccountEmail: this.serviceAccountEmail,
    })
  }
}
