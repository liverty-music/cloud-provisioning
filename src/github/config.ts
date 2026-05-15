export interface GitHubConfig {
	owner: string
	token: string
	billingEmail: string
	geminiApiKey?: string
	anthropicApiKey?: string
	claudeCodeOauthToken?: string
}

export interface BufConfig {
	token: string
}

export enum RepositoryName {
	CLOUD_PROVISIONING = 'cloud-provisioning',
	SPECIFICATION = 'specification',
	BACKEND = 'backend',
	FRONTEND = 'frontend',
	DOT_GITHUB = '.github',
}
