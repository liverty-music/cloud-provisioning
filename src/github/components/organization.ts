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

		// Register outputs
		this.registerOutputs({
			provider: this.provider,
			organizationSettings: this.organizationSettings,
			repositories: this.repositories,
			secrets: this.secrets,
		})
	}
}
