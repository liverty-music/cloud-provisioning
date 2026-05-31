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
	/**
	 * Repository-level Actions variables (not environment-scoped). Used by
	 * workflows that run without an `environment:` binding — e.g.
	 * `bump-prod-pin.yml`'s `repository_dispatch` path, whose conditional
	 * environment resolves to empty, so it cannot read environment variables.
	 * See OpenSpec change `automate-prod-pin-bump`.
	 */
	repositoryVariables?: Record<string, pulumi.Input<string>>
	/**
	 * When set, create a `prod-pin` GitHub Environment whose required reviewer
	 * is this GitHub username (admin). Gates the `bump-prod-pin.yml`
	 * `workflow_dispatch` manual-recovery path behind admin approval; the
	 * automated `repository_dispatch` path does not enter the environment.
	 * See OpenSpec change `automate-prod-pin-bump` design D8.
	 */
	pinBumpReviewerUsername?: string
	/**
	 * When true, the prod `main` protection is expressed as a
	 * `github.RepositoryRuleset` (replacing the classic `BranchProtection`)
	 * with the GitHub Actions integration as an `always` bypass actor. This is
	 * the only mechanism that lets `github-actions[bot]` push the automated
	 * pin-bump straight to `main` past BOTH the PR requirement AND the
	 * strict "up-to-date" status check (classic protection cannot bypass the
	 * strict check per-actor). See OpenSpec change `automate-prod-pin-bump`
	 * D8 / spec "cloud-provisioning branch protection SHALL allow the bot to
	 * bypass". The bypass is scoped to the Actions app only — no human/PAT.
	 */
	mainBranchBotBypass?: boolean
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
			repositoryVariables,
			pinBumpReviewerUsername,
			mainBranchBotBypass,
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

		// Repository-level Actions variables (not environment-scoped). The
		// `bump-prod-pin.yml` workflow's `repository_dispatch` path runs with an
		// empty `environment:`, so it reads the prod WIF provider + SA from here
		// rather than from environment variables.
		if (repositoryVariables) {
			for (const [key, value] of Object.entries(repositoryVariables)) {
				new github.ActionsVariable(
					`${repositoryName}-repo-var-${key}`,
					{
						repository: repositoryName,
						variableName: key,
						value: value,
					},
					{ provider, parent: this },
				)
			}
		}

		// `prod-pin` Environment with a required-reviewer (admin) rule. Gates
		// the `bump-prod-pin.yml` manual `workflow_dispatch` recovery path; the
		// automated `repository_dispatch` path resolves the environment to empty
		// and never enters it (OpenSpec change `automate-prod-pin-bump` D8).
		if (pinBumpReviewerUsername) {
			const reviewer = github.getUserOutput(
				{ username: pinBumpReviewerUsername },
				{ provider },
			)
			new github.RepositoryEnvironment(
				`${repositoryName}-prod-pin`,
				{
					repository: repositoryName,
					environment: 'prod-pin',
					reviewers: [
						{
							// `github_user.id` is the numeric user ID as a string;
							// the reviewers API expects a number.
							users: [reviewer.id.apply((id) => Number(id))],
						},
					],
				},
				{ provider, parent: this },
			)
		}

		this.registerOutputs({
			environment: this.environment,
			variables: this.variables,
			secrets: this.secrets,
		})

		// Apply main-branch protection (Prod Only to avoid stack conflicts).
		if (environment === 'prod') {
			if (mainBranchBotBypass) {
				// Ruleset form (automate-prod-pin-bump): `bump-prod-pin.yml` pushes
				// the prod pin-bump straight to `cloud-provisioning:main` as
				// `github-actions[bot]`, which needs a bypass for BOTH the PR
				// requirement AND the strict "up-to-date" status check. Classic
				// `BranchProtection` has no per-actor bypass for the strict check —
				// only a `RepositoryRuleset` `bypassActors` entry can grant it. We
				// therefore express the protection as a ruleset (it replaces the
				// classic protection rather than stacking with it: the two are
				// evaluated together, so leaving classic protection in place would
				// still block the bot). The bypass is scoped to the GitHub Actions
				// integration only — no human, no PAT (spec: "cloud-provisioning
				// branch protection SHALL allow the bot to bypass").
				//
				// The Actions app id (slug `github-actions`) is resolved via the
				// provider data source rather than hardcoded, so the bypass actor
				// stays correct without a magic number. `actorId` is a number; the
				// data source returns the id as a string.
				const actionsApp = github.getGithubAppOutput(
					{ slug: 'github-actions' },
					{ provider },
				)
				new github.RepositoryRuleset(
					`${repositoryName}-main-ruleset`,
					{
						name: `${repositoryName}-main`,
						repository: repositoryName,
						target: 'branch',
						enforcement: 'active',
						conditions: {
							refName: {
								includes: ['~DEFAULT_BRANCH'],
								excludes: [],
							},
						},
						bypassActors: [
							{
								actorId: actionsApp.id.apply((id) =>
									Number(id),
								),
								actorType: 'Integration',
								// `always`: bypass on direct pushes too, not just PRs —
								// the bot pushes the bump directly, no PR.
								bypassMode: 'always',
							},
						],
						rules: {
							// Require PRs to merge (blocks direct pushes for non-bypass
							// actors); 0 approvals mirrors the classic config.
							pullRequest: {
								requiredApprovingReviewCount: 0,
								dismissStaleReviewsOnPush: false,
								requireCodeOwnerReview: false,
								requireLastPushApproval: false,
							},
							// Block force-push and deletion (classic: allowsForcePushes
							// / allowsDeletions = false).
							nonFastForward: true,
							deletion: true,
							// Strict "require branches up to date" status check.
							...(requiredStatusCheckContexts &&
							requiredStatusCheckContexts.length > 0
								? {
										requiredStatusChecks: {
											requiredChecks:
												requiredStatusCheckContexts.map(
													(context) => ({ context }),
												),
											strictRequiredStatusChecksPolicy:
												requireUpToDateBranch ?? false,
										},
									}
								: {}),
						},
					},
					{ provider, parent: this },
				)
			} else {
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
											strict:
												requireUpToDateBranch ?? false,
											contexts:
												requiredStatusCheckContexts,
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
}
