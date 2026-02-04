import * as github from '@pulumi/github'
import * as pulumi from '@pulumi/pulumi'

export interface GitHubConfig {
  owner: string
  token: string
  billingEmail: string
  geminiApiKey?: string
}

export interface BufConfig {
  token: string
}

export enum RepositoryName {
  CLOUD_PROVISIONING = 'cloud-provisioning',
  SPECIFICATION = 'specification',
  BACKEND = 'backend',
  FRONTEND = 'frontend',
}

// Global Organization Settings & Repositories (Prod only)
export interface GitHubOrganizationComponentArgs {
  brandId: string
  displayName: string
  githubConfig: GitHubConfig
  bufConfig: BufConfig
}

export class GitHubOrganizationComponent extends pulumi.ComponentResource {
  public readonly provider: github.Provider
  public readonly organizationSettings: github.OrganizationSettings
  public readonly repositories: Record<RepositoryName, github.Repository>
  public readonly secrets: (github.ActionsSecret | github.ActionsOrganizationSecret)[]

  constructor(args: GitHubOrganizationComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('github:liverty-music:Organization', 'Organization', {}, opts)

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
      { provider: this.provider, parent: this }
    )

    // Default repository configuration
    const defaultRepositoryArgs: github.RepositoryArgs = {
      visibility: 'public',
      hasIssues: true,
      deleteBranchOnMerge: true,
      vulnerabilityAlerts: true,
      allowMergeCommit: true,
      allowSquashMerge: false,
      allowRebaseMerge: false,
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
      { provider: this.provider, parent: this }
    )

    const specificationRepo = new github.Repository(
      RepositoryName.SPECIFICATION,
      {
        ...defaultRepositoryArgs,
        name: RepositoryName.SPECIFICATION,
        description: 'Specification',
        template: {
          owner: githubConfig.owner,
          repository: 'protobuf-scaffold',
        },
      },
      { provider: this.provider, parent: this }
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
      { provider: this.provider, parent: this }
    )

    const frontendRepo = new github.Repository(
      RepositoryName.FRONTEND,
      {
        ...defaultRepositoryArgs,
        name: RepositoryName.FRONTEND,
        description: 'Frontend',
        template: {
          owner: githubConfig.owner,
          repository: 'web-frontend-scaffold',
        },
      },
      { provider: this.provider, parent: this }
    )

    this.repositories = {
      [RepositoryName.CLOUD_PROVISIONING]: cloudProvisioningRepo,
      [RepositoryName.SPECIFICATION]: specificationRepo,
      [RepositoryName.BACKEND]: backendRepo,
      [RepositoryName.FRONTEND]: frontendRepo,
    }

    // Create secrets
    const bufTokenSecret = new github.ActionsSecret(
      'buf-token',
      {
        repository: RepositoryName.SPECIFICATION,
        secretName: 'BUF_TOKEN',
        plaintextValue: bufConfig.token,
      },
      { provider: this.provider, parent: this }
    )

    this.secrets = [bufTokenSecret]

    if (githubConfig.geminiApiKey) {
      const geminiApiKeySecret = new github.ActionsOrganizationSecret(
        'gemini-api-key',
        {
          secretName: 'GEMINI_API_KEY',
          visibility: 'all',
          plaintextValue: githubConfig.geminiApiKey,
        },
        { provider: this.provider, parent: this }
      )
      this.secrets.push(geminiApiKeySecret)
    }

    // Register outputs
    this.registerOutputs({
      provider: this.provider,
      organizationSettings: this.organizationSettings,
      repositories: this.repositories,
      secrets: this.secrets,
    })
  }
}

// Environment-specific settings per repository
export interface GitHubRepositoryComponentArgs {
  brandId: string
  githubConfig: GitHubConfig
  repositoryName: RepositoryName
  environment: EnvironmentName
  variables: Record<string, pulumi.Input<string>>
  secrets?: Record<string, pulumi.Input<string>>
}

export type EnvironmentName = 'development' | 'production' | 'staging'

export class GitHubRepositoryComponent extends pulumi.ComponentResource {
  public readonly environment: github.RepositoryEnvironment
  public readonly variables: github.ActionsEnvironmentVariable[] = []
  public readonly secrets: github.ActionsEnvironmentSecret[] = []

  constructor(args: GitHubRepositoryComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super(
      `github:liverty-music:Repository:${args.repositoryName}:${args.environment}`,
      args.repositoryName,
      {},
      opts
    )

    const { brandId, githubConfig, repositoryName, environment, variables, secrets } = args

    // Use a new provider instance to ensure we can use it in any stack
    const provider = new github.Provider(
      `github-provider-${repositoryName}-${environment}`,
      {
        owner: brandId,
        token: githubConfig.token,
      },
      { parent: this }
    )

    // Create Environment
    this.environment = new github.RepositoryEnvironment(
      `${repositoryName}-${environment}`,
      {
        repository: repositoryName,
        environment: environment,
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true,
        },
      },
      { provider, parent: this }
    )

    // Create Variables
    for (const [key, value] of Object.entries(variables)) {
      this.variables.push(
        new github.ActionsEnvironmentVariable(
          `${repositoryName}-${environment}-${key}`,
          {
            repository: repositoryName,
            environment: this.environment.environment,
            variableName: key,
            value: value,
          },
          { provider, parent: this }
        )
      )
    }

    // Create Secrets (if any)
    if (secrets) {
      for (const [key, value] of Object.entries(secrets)) {
        this.secrets.push(
          new github.ActionsEnvironmentSecret(
            `${repositoryName}-${environment}-${key}-secret`,
            {
              repository: repositoryName,
              environment: this.environment.environment,
              secretName: key,
              plaintextValue: value,
            },
            { provider, parent: this }
          )
        )
      }
    }

    this.registerOutputs({
      environment: this.environment,
      variables: this.variables,
      secrets: this.secrets,
    })
  }
}
