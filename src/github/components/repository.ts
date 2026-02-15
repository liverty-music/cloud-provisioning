import * as github from '@pulumi/github'
import * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
import type { GitHubConfig, RepositoryName } from '../config.js'

export interface GitHubRepositoryComponentArgs {
	brandId: string
	githubConfig: GitHubConfig
	repositoryName: RepositoryName
	environment: Environment
	variables: Record<string, pulumi.Input<string>>
	secrets?: Record<string, pulumi.Input<string>>
	requiredStatusCheckContexts?: string[]
}

export class GitHubRepositoryComponent extends pulumi.ComponentResource {
	public readonly environment: github.RepositoryEnvironment
	public readonly variables: github.ActionsEnvironmentVariable[] = []
	public readonly secrets: github.ActionsEnvironmentSecret[] = []

	constructor(
		args: GitHubRepositoryComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super(
			`github:liverty-music:Repository:${args.repositoryName}:${args.environment}`,
			args.repositoryName,
			{},
			opts,
		)

		const {
			brandId,
			githubConfig,
			repositoryName,
			environment,
			variables,
			secrets,
			requiredStatusCheckContexts,
		} = args

		// Use a new provider instance to ensure we can use it in any stack
		const provider = new github.Provider(
			`github-provider-${repositoryName}-${environment}`,
			{
				owner: brandId,
				token: githubConfig.token,
			},
			{ parent: this },
		)

		// Create Environment
		this.environment = new github.RepositoryEnvironment(
			`${repositoryName}`,
			{
				repository: repositoryName,
				environment: environment,
				deploymentBranchPolicy:
					environment === 'dev'
						? {
								protectedBranches: false,
								customBranchPolicies: true,
							}
						: {
								protectedBranches: true,
								customBranchPolicies: false,
							},
			},
			{ provider, parent: this },
		)

		// Create Variables
		for (const [key, value] of Object.entries(variables)) {
			this.variables.push(
				new github.ActionsEnvironmentVariable(
					`${repositoryName}-env-${key}`,
					{
						repository: repositoryName,
						environment: this.environment.environment,
						variableName: key,
						value: value,
					},
					{ provider, parent: this },
				),
			)
		}

		// Create Secrets (if any)
		if (secrets) {
			for (const [key, value] of Object.entries(secrets)) {
				this.secrets.push(
					new github.ActionsEnvironmentSecret(
						`${repositoryName}-secret-${key}`,
						{
							repository: repositoryName,
							environment: this.environment.environment,
							secretName: key,
							plaintextValue: value,
						},
						{ provider, parent: this },
					),
				)
			}
		}

		this.registerOutputs({
			environment: this.environment,
			variables: this.variables,
			secrets: this.secrets,
		})

		// Apply Branch Protection (Prod Only to avoid stack conflicts)
		if (environment === 'prod') {
			new github.BranchProtection(
				`${repositoryName}-protection`,
				{
					repositoryId: repositoryName,
					pattern: 'main',
					enforceAdmins: true,
					allowsDeletions: false,
					allowsForcePushes: false,
					requiredLinearHistory: false,
					requireConversationResolution: false,
					// Require status checks to pass before merging (if specified)
					// Note: Gemini Review is intentionally excluded from all repositories
					...(requiredStatusCheckContexts &&
					requiredStatusCheckContexts.length > 0
						? {
								requiredStatusChecks: [
									{
										strict: true, // Require branches to be up to date before merging
										contexts: requiredStatusCheckContexts,
									},
								],
							}
						: {}),
					// Require pull requests before merging (blocks direct pushes)
					requiredPullRequestReviews: [
						{
							dismissStaleReviews: false,
							restrictDismissals: false,
							requiredApprovingReviewCount: 0,
							requireCodeOwnerReviews: false,
						},
					],
					// Block direct pushes to main branch (empty array = no one can push directly)
					restrictPushes: [],
				},
				{ provider, parent: this },
			)
		}
	}
}
