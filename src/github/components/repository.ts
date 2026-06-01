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
	 * When true AND `botBypassAppId` is set, the prod `main` protection is
	 * expressed as a `github.RepositoryRuleset` (replacing the classic
	 * `BranchProtection`) with the org-owned bump App as an `always` bypass
	 * actor, letting the automated pin-bump push straight to `main` past BOTH
	 * the PR requirement AND the strict "up-to-date" status check. Classic
	 * protection cannot bypass the strict check per-actor. If false / no app id,
	 * classic `BranchProtection` is used instead. See OpenSpec change
	 * `automate-prod-pin-bump`.
	 */
	mainBranchBotBypass?: boolean
	/**
	 * GitHub App ID used as the org-owned bypass actor on the `main` ruleset
	 * (and the identity the bump workflow pushes as). MUST be an org-owned App:
	 * the global `github-actions` integration is rejected by a repo ruleset
	 * ("must be part of the ruleset source or owner organization"), and an org
	 * ruleset (which would accept it) needs a GitHub Team plan. The
	 * `liverty-music-ci-bot` App id (`ciBotAppId`) is passed here.
	 */
	botBypassAppId?: pulumi.Input<string>
	/**
	 * Repository-level Actions secrets (not environment-scoped). Used by
	 * `bump-prod-pin.yml`'s `repository_dispatch` path (empty `environment:`,
	 * so it cannot read environment secrets) to mint the ci-bot token it pushes
	 * to `main` with.
	 */
	repositorySecrets?: Record<string, pulumi.Input<string>>
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
			botBypassAppId,
			repositorySecrets,
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

		// Repository-level Actions secrets (not environment-scoped). The
		// `bump-prod-pin.yml` `repository_dispatch` path runs with an empty
		// `environment:`, so it reads the ci-bot App credential from here to mint
		// the installation token it pushes the bump to `main` with.
		if (repositorySecrets) {
			for (const [key, value] of Object.entries(repositorySecrets)) {
				new github.ActionsSecret(
					`${repositoryName}-repo-secret-${key}`,
					{
						repository: repositoryName,
						secretName: key,
						plaintextValue: value,
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
			if (mainBranchBotBypass && botBypassAppId) {
				// Ruleset form (automate-prod-pin-bump): `bump-prod-pin.yml` pushes
				// the prod pin-bump straight to `cloud-provisioning:main`, which
				// needs a bypass for BOTH the PR requirement AND the strict
				// "up-to-date" status check. Classic `BranchProtection` has no
				// per-actor bypass for the strict check, so we use a
				// `RepositoryRuleset` with a `bypassActors` entry.
				//
				// The bypass actor is the org-owned `liverty-music-ci-bot` App
				// (`botBypassAppId`), NOT the built-in `github-actions[bot]`: a repo
				// ruleset rejects the global `github-actions` integration with
				// "Actor GitHub Actions integration must be part of the ruleset
				// source or owner organization" (it is GitHub-owned), and an *org*
				// ruleset (which would accept it) requires a GitHub Team plan
				// (403 on Free). An org-owned App passes the repo-ruleset
				// validation. The bump workflow therefore pushes to main using a
				// ci-bot installation token (see bump-prod-pin.yml), and ci-bot is
				// the sole bypass actor — no human, no PAT.
				//
				// Trade-off (vs the original design D1): ci-bot is ALSO the
				// cross-repo dispatch credential held on the backend/frontend prod
				// environments, so a compromised prod release workflow could mint a
				// ci-bot token and push to `cloud-provisioning:main`. This relaxes
				// the D1 "dispatch token cannot move prod" boundary; it is mitigated
				// by the prod-environment gating of those secrets, the provenance
				// gate, and Release-as-the-human-gate. See the updated spec.
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
								actorId: pulumi
									.output(botBypassAppId)
									.apply((id) => Number(id)),
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
