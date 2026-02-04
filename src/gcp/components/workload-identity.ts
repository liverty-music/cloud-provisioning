import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { Environment } from '../../config.js'
import { IamService, Roles } from '../services/iam.js'

export interface WorkloadIdentityComponentArgs {
  environment: Environment
  folder: gcp.organizations.Folder | pulumi.Output<gcp.organizations.Folder>
  project: gcp.organizations.Project
}

export class WorkloadIdentityComponent extends pulumi.ComponentResource {
  public readonly pool: gcp.iam.WorkloadIdentityPool
  public readonly provider: gcp.iam.WorkloadIdentityPoolProvider
  public readonly githubProvider: gcp.iam.WorkloadIdentityPoolProvider

  private readonly iamService: IamService
  private readonly PULUMI_ORG = 'pannpers'
  private readonly PULUMI_OIDC_ISSUER = 'https://api.pulumi.com/oidc'

  constructor(args: WorkloadIdentityComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:WorkloadIdentityFederation', 'WorkloadIdentityFederation', args, opts)

    const { environment, folder, project } = args

    this.iamService = new IamService(project)

    // 1. Create Workload Identity Pool (per environment)
    // This pool is for ALL external providers.
    this.pool = new gcp.iam.WorkloadIdentityPool(
      `external-providers`,
      {
        workloadIdentityPoolId: `external-providers`,
        project: project.projectId,
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
        project: project.projectId,
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

    // 3. Create OIDC Provider for GitHub Actions
    // This allows GitHub Actions to authenticate via OIDC
    this.githubProvider = new gcp.iam.WorkloadIdentityPoolProvider(
      `github-provider`,
      {
        workloadIdentityPoolId: this.pool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: 'github-provider',
        project: project.projectId,
        displayName: 'GitHub Actions OIDC Provider',
        description: 'OIDC Provider for GitHub Actions authentication',
        attributeMapping: {
          'google.subject': 'assertion.sub',
          'attribute.actor': 'assertion.actor',
          'attribute.repository': 'assertion.repository',
          'attribute.repository_owner': 'assertion.repository_owner',
        },
        attributeCondition: `attribute.repository_owner == 'liverty-music'`,
        oidc: {
          issuerUri: 'https://token.actions.githubusercontent.com',
        },
      },
      { parent: this, dependsOn: [this.pool] }
    )

    // 3. Create Service Account for Pulumi Deployments
    const pulumiSAName = 'pulumi-cloud'
    const pulumiSA = this.iamService.createServiceAccount(
      pulumiSAName,
      pulumiSAName,
      'Pulumi Cloud Service Account',
      'Service Account for Pulumi Deployments to provision resources',
      this
    )

    // 4. Grant workloadIdentityUser to allow Pulumi Deployments to impersonate the SA
    this.iamService.bindWifUser(pulumiSAName, `*`, pulumiSA, this.pool, this)

    // 5. Grant owner role to the service account on the project
    this.iamService.bindProjectRoles([Roles.Project.Owner], pulumiSAName, pulumiSA.email, this)

    // 6. Grant folderViewer role to the service account on the folder
    this.iamService.bindFolderRoles(
      [Roles.ResourceManager.FolderViewer],
      pulumiSAName,
      pulumiSA.email,
      folder,
      this
    )

    // 7. GitHub Actions CI/CD Service Account
    const githubActionsSAName = 'github-actions'
    const githubActionsSA = this.iamService.createServiceAccount(
      githubActionsSAName,
      githubActionsSAName,
      'GitHub Actions Service Account',
      'Service Account for GitHub Actions to push images to Artifact Registry',
      this
    )

    // Grant Artifact Registry Writer to GitHub Actions SA
    this.iamService.bindProjectRoles(
      [Roles.ArtifactRegistry.Writer],
      githubActionsSAName,
      githubActionsSA.email,
      this
    )

    // Enable backend CI job to impersonate GitHub Actions SA via WIF
    this.iamService.bindWifUser(
      githubActionsSAName,
      `attribute.repository/liverty-music/backend`,
      githubActionsSA,
      this.pool,
      this
    )

    this.registerOutputs({
      pool: this.pool,
      provider: this.provider,
      githubProvider: this.githubProvider,
    })
  }
}
