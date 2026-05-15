import * as pulumi from '@pulumi/pulumi'
import type { CloudflareConfig } from './cloudflare/config.js'
import type { Environment } from './config.js'
import type { BlockchainConfig, GcpConfig } from './gcp/components/project.js'
import { Gcp } from './gcp/index.js'
import {
	type BufConfig,
	type GitHubConfig,
	GitHubOrganizationComponent,
	GitHubRepositoryComponent,
	RepositoryName,
} from './github/index.js'
import { SecretsComponent, Zitadel } from './zitadel/index.js'

const brandId = 'liverty-music'
const displayName = 'Liverty Music'

const config = new pulumi.Config('liverty-music')
const githubConfig = config.requireObject('github') as GitHubConfig
const gcpConfig = config.requireObject('gcp') as GcpConfig
const lastFmApiKey = config.getSecret('lastFmApiKey')
const fanartTvApiKey = config.getSecret('fanartTvApiKey')
const blockchainConfig = config.getObject('blockchain') as
	| BlockchainConfig
	| undefined
const bufConfig = config.requireObject('buf') as BufConfig
const cloudflareConfig = config.getObject('cloudflare') as CloudflareConfig
const postmarkConfig = config.requireObject(
	'postmark',
) as import('./gcp/components/network.js').PostmarkDnsConfig & {
	serverApiToken: string
}

// Google OAuth 2.0 Web Application client credentials for the admin
// Google IdP that gates Zitadel Admin Console sign-in. Set per-env via
// ESC: `pulumiConfig.zitadel.googleAdminIdp.clientId` (plaintext) and
// `pulumiConfig.zitadel.googleAdminIdp.clientSecret` (encrypted).
// See OpenSpec change `add-zitadel-console-admin-via-google-idp`.
//
// Read via the project-level config (matching the existing pattern
// `config.requireObject('postmark')`) — `pulumi.Config()` defaults to the
// `liverty-music` project namespace. A `pulumi.Config('zitadel')` would
// look in the unrelated `zitadel:` provider namespace and fail.
const zitadelConfig = config.requireSecretObject<{
	googleAdminIdp: { clientId: string; clientSecret: string }
	adminGoogleSubs: { pannpers: string }
	e2eTestUser: { password: string }
}>('zitadel')

const env = pulumi.getStack() as Environment

// 1. GitHub Organization Configuration (Prod Only)
if (env === 'prod') {
	new GitHubOrganizationComponent({
		brandId,
		displayName,
		githubConfig: {
			...githubConfig,
			geminiApiKey: gcpConfig.geminiApiKey,
			anthropicApiKey: githubConfig.anthropicApiKey,
		},
		bufConfig,
	})
}

// 4. Zitadel Identity (self-hosted, all envs).
// Single unified `Zitadel` class per `refactor-unify-env-dispatch`. The
// admin SA JWT is read from GSM `zitadel-machine-key-for-pulumi-admin`
// (populated once by the in-cluster `bootstrap-uploader` sidecar on
// first-instance Zitadel boot) inside the class. Both
// `zitadelMachineKey` and `zitadelLoginPat` flow through `Gcp` for all
// envs to create the corresponding GSM Secrets in the standard
// `KubernetesComponent.secrets` / `esoOnlySecrets` paths.
const zitadel = new Zitadel('liverty-music', {
	env,
	gcpProjectId: `${brandId}-${env}`,
	postmarkServerApiToken: postmarkConfig.serverApiToken,
	// `zitadelConfig` is `pulumi.Output<{ googleAdminIdp: ... }>` because
	// `requireSecretObject` marks the entire object as secret. Derived
	// values are therefore secret-marked Outputs in Pulumi state.
	googleAdminIdpClientId: zitadelConfig.apply(
		(z) => z.googleAdminIdp.clientId,
	),
	googleAdminIdpClientSecret: zitadelConfig.apply(
		(z) => z.googleAdminIdp.clientSecret,
	),
	pannpersGoogleSub: zitadelConfig.apply((z) => z.adminGoogleSubs.pannpers),
	// E2E test user password — only consumed when `env === 'dev'` inside
	// the unified class; the class's `if (env === 'dev')` gate validates
	// presence at instantiation time.
	e2eTestUserPassword:
		env === 'dev'
			? zitadelConfig.apply((z) => z.e2eTestUser.password)
			: undefined,
})
const zitadelMachineKey = zitadel.machineKeyDetails
const zitadelLoginPat = zitadel.loginClientToken

// 2. GCP Infrastructure (All Environments)
const gcp = new Gcp({
	brandId,
	displayName,
	environment: env,
	gcpConfig,
	lastFmApiKey,
	fanartTvApiKey,
	blockchainConfig,
	cloudflareConfig,
	postmarkConfig,
	zitadelMachineKey,
	zitadelLoginPat,
})

// 5. Self-hosted Zitadel infra phase (all envs).
// Provisions GSM secret shells (masterkey, empty admin-sa-key) that the
// in-cluster Zitadel pod's bootstrap sidecar populates on first boot.
// Per `refactor-unify-env-dispatch` D1, the env allowlist guard
// (`env === 'dev' || env === 'prod'`) was removed because `Environment`
// is now `'dev' | 'prod'` — the guard was no-op.
new SecretsComponent('zitadel-secrets', {
	project: gcp.project,
	zitadelServiceAccountEmail: gcp.zitadelServiceAccountEmail,
	esoServiceAccountEmail: gcp.esoServiceAccountEmail,
})

// 3. GitHub Repository Environments (All Environments)
const sharedVariables = {
	REGION: gcp.region,
	PROJECT_ID: gcp.projectId,
	WORKLOAD_IDENTITY_PROVIDER: gcp.githubWorkloadIdentityProvider,
	SERVICE_ACCOUNT: gcp.githubActionsSAEmail,
}

// Backend Repository
new GitHubRepositoryComponent({
	brandId,
	githubConfig,
	repositoryName: RepositoryName.BACKEND,
	environment: env,
	variables: sharedVariables,
	requiredStatusCheckContexts: ['CI Success'],
})

// Frontend Repository
new GitHubRepositoryComponent({
	brandId,
	githubConfig,
	repositoryName: RepositoryName.FRONTEND,
	environment: env,
	variables: sharedVariables,
	requiredStatusCheckContexts: ['CI Success'],
})

// Specification Repository
new GitHubRepositoryComponent({
	brandId,
	githubConfig,
	repositoryName: RepositoryName.SPECIFICATION,
	environment: env,
	variables: sharedVariables,
	requiredStatusCheckContexts: ['CI Success'],
})

// Cloud Provisioning Repository
new GitHubRepositoryComponent({
	brandId,
	githubConfig,
	repositoryName: RepositoryName.CLOUD_PROVISIONING,
	environment: env,
	variables: sharedVariables,
	requiredStatusCheckContexts: ['CI Success'],
	requireUpToDateBranch: true,
})

// Export common resources
export const folder = gcp.folder
export const project = gcp.project
// Export for debug/reference
export const githubEnv = env

// Frontend SPA OIDC client_id + product-org id — consumed by the
// frontend repo's `.env.{dev,prod}` to bake into the SPA bundle at
// build time. Operators retrieve via `pulumi stack output
// webFrontendClientId` / `pulumi stack output productOrgId` after
// `pulumi up`. See OpenSpec change `prepare-prod-service-in` §1.2 /
// §2.3 for the prod consumption path; the identity-management spec's
// "Manage OIDC Application" requirement makes these per-env values
// the contract surface the frontend build depends on.
export const webFrontendClientId = zitadel.frontend.application.clientId
export const productOrgId = zitadel.productOrg.id
