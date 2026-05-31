export interface GitHubConfig {
	owner: string
	token: string
	billingEmail: string
	geminiApiKey?: string
	anthropicApiKey?: string
	claudeCodeOauthToken?: string
	// GitHub App credential used by the backend/frontend release workflows to
	// trigger the cross-repo `bump-prod-pin` `repository_dispatch`. Wired as
	// the `PROD_PIN_DISPATCH_APP_ID` / `PROD_PIN_DISPATCH_APP_PRIVATE_KEY`
	// secrets on the backend + frontend `prod` environments. Optional: when
	// unset (e.g. dev stack, or before the App is created) no secret is
	// provisioned. See OpenSpec change `automate-prod-pin-bump` and
	// docs/runbooks/prod-image-tag-pinning.md "Automation setup".
	prodPinDispatchAppId?: string
	prodPinDispatchAppPrivateKey?: string
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
