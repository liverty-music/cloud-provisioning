import type * as github from '@pulumi/github'

export interface GitHubConfig {
	owner: string
	// The Pulumi GitHub provider authenticates as the org-owned GitHub App
	// `liverty-music-pulumi` (installed on every repository of the organization),
	// not as a personal access token: the App does not depend on one person's
	// account, and its installation tokens expire after an hour. Its permissions
	// are edited on the App's settings page, so a new resource type that needs
	// one more permission does not mean minting a new credential. Set in ESC
	// `liverty-music/common` as `pulumiConfig.github.pulumiApp*`. See
	// docs/runbooks/github-app-credentials.md.
	pulumiAppId: string
	pulumiAppInstallationId: string
	pulumiAppPrivateKey: string
	billingEmail: string
	geminiApiKey?: string
	anthropicApiKey?: string
	claudeCodeOauthToken?: string
	// Shared org CI-automation GitHub App (`liverty-music-ci-bot`). Used by the
	// backend/frontend release workflows to trigger the cross-repo
	// `bump-prod-pin` `repository_dispatch`, and reusable for future cross-repo
	// CI automation at the same trust level. Wired as the `CI_BOT_APP_ID` /
	// `CI_BOT_APP_PRIVATE_KEY` secrets on the backend + frontend `prod`
	// environments. Optional: when unset (e.g. dev stack, or before the App is
	// created) no secret is provisioned. See OpenSpec change
	// `automate-prod-pin-bump` and docs/runbooks/prod-image-tag-pinning.md
	// "Automation setup".
	ciBotAppId?: string
	ciBotAppPrivateKey?: string
}

/**
 * Provider arguments that authenticate as the `liverty-music-pulumi` GitHub App.
 */
export function githubAppAuth(
	githubConfig: GitHubConfig,
): Pick<github.ProviderArgs, 'appAuth'> {
	return {
		appAuth: {
			id: githubConfig.pulumiAppId,
			installationId: githubConfig.pulumiAppInstallationId,
			pemFile: githubConfig.pulumiAppPrivateKey,
		},
	}
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
