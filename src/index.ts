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

// 4. Zitadel Identity (self-hosted, dev only post-cutover).
// Provider points at `https://auth.dev.liverty-music.app`; admin SA key is
// pulled from GSM `zitadel-admin-sa-key` (populated once by the in-cluster
// bootstrap-uploader sidecar). Cutover scope is dev-only (OpenSpec D10);
// the env guard inside the Zitadel class throws if invoked from staging /
// prod until those environments get their own self-hosted instance.
let zitadelMachineKey: pulumi.Output<string> | undefined
let zitadelLoginPat: pulumi.Output<string> | undefined
if (env === 'dev') {
	const zitadel = new Zitadel('liverty-music', {
		env,
		gcpProjectId: `${brandId}-${env}`,
		postmarkServerApiToken: postmarkConfig.serverApiToken,
	})
	zitadelMachineKey = zitadel.machineKeyDetails
	zitadelLoginPat = zitadel.loginClientToken
}

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

// 5. Self-hosted Zitadel infra phase (dev only).
// Provisions GSM secret shells (masterkey, empty admin-sa-key) that the
// in-cluster Zitadel pod's bootstrap sidecar will populate on first boot.
// The cutover PR reads `zitadel-admin-sa-key` from GSM to reconfigure the
// Zitadel Pulumi provider at the self-hosted hostname. Always running this
// phase (even before cutover) is safe: the secret shells don't affect the
// Cloud-tenant Zitadel resources above.
if (env === 'dev') {
	new SecretsComponent('zitadel-secrets', {
		project: gcp.project,
		zitadelServiceAccountEmail: gcp.zitadelServiceAccountEmail,
		esoServiceAccountEmail: gcp.esoServiceAccountEmail,
	})
}

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
