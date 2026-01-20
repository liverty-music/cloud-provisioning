import * as github from '@pulumi/github'
import * as pulumi from '@pulumi/pulumi'

export interface GitHubConfig {
  owner: string
  token: string
  billingEmail: string
}

export interface BufConfig {
  token: string
}

export interface GitHubComponentArgs {
  brandId: string
  displayName: string
  githubConfig: GitHubConfig
  bufConfig: BufConfig
}

export enum RepositoryName {
  CLOUD_PROVISIONING = 'cloud-provisioning',
  SCHEMA = 'schema',
  BACKEND = 'backend',
  FRONTEND = 'frontend',
}

export class GitHubComponent extends pulumi.ComponentResource {
  public readonly provider: github.Provider
  public readonly organizationSettings: github.OrganizationSettings
  public readonly repositories: Record<RepositoryName, github.Repository>
  public readonly secrets: github.ActionsSecret[]

  constructor(args: GitHubComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('GitHub', 'github', {}, opts)

    const { brandId, displayName, githubConfig, bufConfig } = args

    // Create GitHub provider
    this.provider = new github.Provider('github-provider', {
      owner: brandId,
      token: githubConfig.token,
    })

    // Create organization settings
    this.organizationSettings = new github.OrganizationSettings(
      brandId,
      {
        name: displayName,
        description: displayName,
        defaultRepositoryPermission: 'read',
        billingEmail: githubConfig.billingEmail,
        membersCanCreatePrivateRepositories: false,
        membersCanCreatePages: true,
      },
      { provider: this.provider }
    )

    // Default repository configuration
    const defaultRepositoryArgs: github.RepositoryArgs = {
      visibility: 'public',
      hasIssues: true,
      deleteBranchOnMerge: true,
      vulnerabilityAlerts: true,
    }

    // Create repositories
    const cloudProvisioningRepo = new github.Repository(
      RepositoryName.CLOUD_PROVISIONING,
      {
        ...defaultRepositoryArgs,
        name: RepositoryName.CLOUD_PROVISIONING,
        description: 'Cloud Provisioning',
        template: {
          owner: githubConfig.owner,
          repository: 'cloud-provisioning-scaffold',
        },
      },
      { provider: this.provider }
    )

    const schemaRepo = new github.Repository(
      RepositoryName.SCHEMA,
      {
        ...defaultRepositoryArgs,
        name: RepositoryName.SCHEMA,
        description: 'Schema',
        template: {
          owner: githubConfig.owner,
          repository: 'protobuf-scaffold',
        },
      },
      { provider: this.provider }
    )

    const backendRepo = new github.Repository(
      RepositoryName.BACKEND,
      {
        ...defaultRepositoryArgs,
        name: RepositoryName.BACKEND,
        description: 'Backend',
        template: {
          owner: githubConfig.owner,
          repository: 'go-backend-scaffold',
        },
      },
      { provider: this.provider }
    )

    const frontendRepo = new github.Repository(
      RepositoryName.FRONTEND,
      {
        ...defaultRepositoryArgs,
        name: RepositoryName.FRONTEND,
        description: 'Frontend',
      },
      { provider: this.provider }
    )

    this.repositories = {
      [RepositoryName.CLOUD_PROVISIONING]: cloudProvisioningRepo,
      [RepositoryName.SCHEMA]: schemaRepo,
      [RepositoryName.BACKEND]: backendRepo,
      [RepositoryName.FRONTEND]: frontendRepo,
    }

    // Create secrets
    const bufTokenSecret = new github.ActionsSecret(
      'buf-token',
      {
        repository: RepositoryName.SCHEMA,
        secretName: 'BUF_TOKEN',
        plaintextValue: bufConfig.token,
      },
      { provider: this.provider }
    )

    this.secrets = [bufTokenSecret]

    // Register outputs
    this.registerOutputs({
      provider: this.provider,
      organizationSettings: this.organizationSettings,
      repositories: this.repositories,
      secrets: this.secrets,
    })
  }
}
