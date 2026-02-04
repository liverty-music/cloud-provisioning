import * as github from '@pulumi/github'
import * as pulumi from '@pulumi/pulumi'
import { GitHubConfig, RepositoryName, EnvironmentName } from '../config.js'

export interface GitHubRepositoryComponentArgs {
  brandId: string
  githubConfig: GitHubConfig
  repositoryName: RepositoryName
  environment: EnvironmentName
  variables: Record<string, pulumi.Input<string>>
  secrets?: Record<string, pulumi.Input<string>>
}

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
