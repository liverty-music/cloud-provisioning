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
	/**
	 * Require the PR branch to be up-to-date with main before merging.
	 * Prevents merging stale branches that may cause unintended resource deletions
	 * (e.g., Pulumi removing resources added by a recently merged PR).
	 */
	requireUpToDateBranch?: boolean
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
			requireUpToDateBranch,
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

		// Create Environment.
		//
		// Both dev and prod use `customBranchPolicies: true` so each env can
		// explicitly allow-list the refs it accepts. The previous prod-only
		// `protectedBranches: true` blocked release-tag deploys with
		// "Tag X is not allowed to deploy to prod due to environment
		// protection rules" because tags are never "protected branches" in
		// GitHub's data model. The OpenSpec change `prepare-prod-service-in`
		// §5 release-tag-triggered prod build path needs the `v*` tag
		// pattern declared below; D7 OQ1 anticipated this gap.
		this.environment = new github.RepositoryEnvironment(
			`${repositoryName}`,
			{
				repository: repositoryName,
				environment: environment,
				deploymentBranchPolicy: {
					protectedBranches: false,
					customBranchPolicies: true,
				},
			},
			{ provider, parent: this },
		)

		// Per-env allowed deployment branches / tags. dev historically ran
		// with zero patterns yet permitted push-to-main deploys (GitHub
		// empirically allows refs when custom_branch_policies is true and
		// patterns are absent); making the allow-list explicit removes that
		// ambiguity and gives prod the `v*` tag entry it needs for the
		// release-triggered build path. The Pulumi `@pulumi/github` API
		// distinguishes `branchPattern` from `tagPattern` (two different
		// resources cover the two ref types), so we declare them as separate
		// arrays.
		const allowedBranches = ['main']
		const allowedTags = environment === 'prod' ? ['v*'] : []
		for (const pattern of allowedBranches) {
			new github.RepositoryEnvironmentDeploymentPolicy(
				`${repositoryName}-deploy-branch-${pattern.replace(/[^a-z0-9-]/gi, '-')}`,
				{
					repository: repositoryName,
					environment: this.environment.environment,
					branchPattern: pattern,
				},
				{ provider, parent: this, dependsOn: [this.environment] },
			)
		}
		for (const pattern of allowedTags) {
			new github.RepositoryEnvironmentDeploymentPolicy(
				`${repositoryName}-deploy-tag-${pattern.replace(/[^a-z0-9-]/gi, '-')}`,
				{
					repository: repositoryName,
					environment: this.environment.environment,
					tagPattern: pattern,
				},
				{ provider, parent: this, dependsOn: [this.environment] },
			)
		}

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
										strict: requireUpToDateBranch ?? false,
										contexts: requiredStatusCheckContexts,
									},
								],
							}
						: requireUpToDateBranch
							? {
									requiredStatusChecks: [
										{
											strict: true,
											contexts: [],
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
