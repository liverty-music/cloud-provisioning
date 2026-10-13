import * as github from '@pulumi/github'
import * as pulumi from '@pulumi/pulumi'
import { type BufConfig, type GitHubConfig, RepositoryName } from '../config.js'

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
	public readonly secrets: (
		| github.ActionsSecret
		| github.ActionsOrganizationSecret
	)[]

	constructor(
		args: GitHubOrganizationComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
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
			{ provider: this.provider, parent: this },
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
			// Lets a pull request be queued to merge once its required checks
			// pass. This is PERMISSION, not policy: it grants nothing on its own,
			// and Renovate's own `automerge` is off org-wide, so nothing merges
			// unattended until that is turned on group by group.
			//
			// It has to live here rather than in GitHubRepositoryComponent,
			// because it is a `github.Repository` argument and that component
			// manages protection, environments, variables and secrets — not the
			// repository resource itself.
			//
			// This reaches ALL FIVE repositories, including `.github`, which has
			// no branch protection and no CI. Nothing stops an auto-merge landing
			// there with no gate at all except Renovate's permanent exclusion for
			// that repository in the org preset — so do not remove that rule
			// while this is enabled (design D11, and follow-up 12.4 is the real
			// remedy).
			//
			// The gate itself is unchanged: `requiredStatusCheckContexts` stays
			// `['CI Success']` on the other four, and an auto-merge satisfies the
			// same branch protection a human merge does. The strategy is
			// merge-commit only, since squash and rebase are both false above.
			allowAutoMerge: true,
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
			{ provider: this.provider, parent: this },
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
			{ provider: this.provider, parent: this },
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
			{ provider: this.provider, parent: this },
		)

		const frontendRepo = new github.Repository(
			RepositoryName.FRONTEND,
			{
				...defaultRepositoryArgs,
				name: RepositoryName.FRONTEND,
				description: 'Frontend',
			},
			{ provider: this.provider, parent: this },
		)

		// Hosts org-wide community files and reusable workflows (e.g., the
		// Claude review reusable workflow consumed by every other repo).
		// Pulumi logical name is kebab-case (per CLAUDE.md "Code
		// Conventions"); the actual GitHub repo name is the dotted
		// `.github` set via the `name:` field.
		const dotGithubRepo = new github.Repository(
			'dot-github',
			{
				...defaultRepositoryArgs,
				name: RepositoryName.DOT_GITHUB,
				description: 'Org-wide community files and reusable workflows',
			},
			{ provider: this.provider, parent: this },
		)

		this.repositories = {
			[RepositoryName.CLOUD_PROVISIONING]: cloudProvisioningRepo,
			[RepositoryName.SPECIFICATION]: specificationRepo,
			[RepositoryName.BACKEND]: backendRepo,
			[RepositoryName.FRONTEND]: frontendRepo,
			[RepositoryName.DOT_GITHUB]: dotGithubRepo,
		}

		// Create secrets
		const bufTokenSecret = new github.ActionsSecret(
			'buf-token',
			{
				repository: RepositoryName.SPECIFICATION,
				secretName: 'BUF_TOKEN',
				plaintextValue: bufConfig.token,
			},
			{ provider: this.provider, parent: this },
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
				{ provider: this.provider, parent: this },
			)
			this.secrets.push(geminiApiKeySecret)
		}

		if (githubConfig.anthropicApiKey) {
			const anthropicApiKeySecret = new github.ActionsOrganizationSecret(
				'anthropic-api-key',
				{
					secretName: 'ANTHROPIC_API_KEY',
					visibility: 'all',
					plaintextValue: githubConfig.anthropicApiKey,
				},
				{ provider: this.provider, parent: this },
			)
			this.secrets.push(anthropicApiKeySecret)
		}

		// Authenticates the reusable Claude review workflow
		// (`liverty-music/.github/.github/workflows/claude-review.yml`)
		// against the Claude.ai Max plan subscription instead of the
		// console.anthropic.com pay-as-you-go API credit balance. See
		// OpenSpec change `claude-review-check-run` design.md for the
		// auth-path rationale.
		//
		// `visibility: 'all'` makes the secret available to every repo in
		// the org, including any repo-level `CLAUDE_CODE_OAUTH_TOKEN` that
		// may have been manually configured earlier — when both exist,
		// GitHub's `secrets` context resolves to the repo-level secret,
		// so this org-level secret only supplies the value to repos that
		// do not yet have it (currently backend/frontend/cloud-provisioning).
		if (githubConfig.claudeCodeOauthToken) {
			const claudeCodeOauthTokenSecret =
				new github.ActionsOrganizationSecret(
					'claude-code-oauth-token',
					{
						secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
						visibility: 'all',
						plaintextValue: githubConfig.claudeCodeOauthToken,
					},
					{ provider: this.provider, parent: this },
				)
			this.secrets.push(claudeCodeOauthTokenSecret)
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
