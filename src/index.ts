import * as gcpProvider from '@pulumi/gcp'
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
// Only orgId is still read from Pulumi config; domain and jwtProfileJson come
// from code + GCP Secret Manager in the self-hosted model.
const zitadelOrgId = (config.getObject('zitadel') as { orgId?: string })?.orgId
const cloudflareConfig = config.getObject('cloudflare') as CloudflareConfig
const postmarkConfig = config.requireObject(
	'postmark',
) as import('./gcp/components/network.js').PostmarkDnsConfig & {
	serverApiToken: string
}

const env = pulumi.getStack() as Environment

// Self-hosted Zitadel domain per environment. Hardcoded (rather than
// config-driven) because it is tightly coupled to DNS / Gateway manifests that
// also reference these hostnames.
const zitadelDomainMap: Record<Environment, string> = {
	dev: 'auth.dev.liverty-music.app',
	staging: 'auth.staging.liverty-music.app',
	prod: 'auth.liverty-music.app',
}

// Gating flag for the Zitadel config phase. On the very first apply of a
// fresh self-hosted Zitadel (before the in-cluster bootstrap Job has written
// the admin SA key to GSM), leave this false so Pulumi only provisions infra
// (GSM secret shells, Cloud SQL DB, IAM users). Flip to true once the
// bootstrap Job has populated `zitadel-admin-sa-key`, and Pulumi will then
// provision Project/App/LoginPolicy/SMTP/MachineUser/Actions v2.
const zitadelConfigureEnabled =
	config.getBoolean('zitadel.configureEnabled') ?? false

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

// 2. GCP Infrastructure (All Environments) — created BEFORE Zitadel so the
// Zitadel stack can consume the GCP service-account emails it depends on.
// `zitadelMachineKey` is populated later in a separate GSM secret once the
// Zitadel config phase creates the backend-app machine user.
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
})

// 3. Zitadel Identity
if (env === 'dev') {
	// 3a. Infra phase (always): provision GSM secret shells so the in-cluster
	// bootstrap Job has a destination to write the admin SA key to on first
	// boot. Also generates the immutable 32-byte masterkey.
	new SecretsComponent('zitadel-secrets', {
		project: gcp.project,
		zitadelServiceAccountEmail: gcp.zitadelServiceAccountEmail,
		esoServiceAccountEmail: gcp.esoServiceAccountEmail,
	})

	// 3b. Config phase: only runs once the bootstrap Job has populated the
	// admin SA key in GSM. The caller flips `zitadel.configureEnabled: true`
	// after verifying the Job completed successfully.
	if (zitadelConfigureEnabled) {
		const adminSaKey = gcpProvider.secretmanager.getSecretVersionOutput({
			secret: 'zitadel-admin-sa-key',
			project: gcp.projectId,
		})

		const zitadel = new Zitadel('liverty-music', {
			env,
			config: {
				orgId: zitadelOrgId ?? '',
				domain: zitadelDomainMap[env],
				pulumiJwtProfileJson: adminSaKey.secretData,
				postmarkServerApiToken: postmarkConfig.serverApiToken,
				// In-cluster backend webhook endpoints for Actions v2 Targets.
				// The backend is reached via ClusterIP Service; no TLS needed.
				preAccessTokenEndpoint:
					'http://server.backend.svc.cluster.local:8080/pre-access-token',
				autoVerifyEmailEndpoint:
					'http://server.backend.svc.cluster.local:8080/auto-verify-email',
			},
		})

		// Standalone GSM secret for the backend-app machine user's JWT profile.
		// This is separate from the admin SA key above — the admin key is
		// consumed by Pulumi itself, whereas the machine-key is consumed by
		// the backend at runtime for outbound Zitadel Management API calls.
		const machineKeySecret = new gcpProvider.secretmanager.Secret(
			'zitadel-machine-key',
			{
				secretId: 'zitadel-machine-key',
				project: gcp.projectId,
				replication: { auto: {} },
			},
		)
		new gcpProvider.secretmanager.SecretVersion(
			'zitadel-machine-key-version',
			{
				secret: machineKeySecret.id,
				secretData: pulumi.secret(zitadel.machineKeyDetails),
			},
		)
		new gcpProvider.secretmanager.SecretIamMember(
			'zitadel-machine-key-backend-app-accessor',
			{
				secretId: machineKeySecret.secretId,
				project: gcp.projectId,
				role: 'roles/secretmanager.secretAccessor',
				member: pulumi.interpolate`serviceAccount:${gcp.backendAppServiceAccountEmail}`,
			},
		)
		new gcpProvider.secretmanager.SecretIamMember(
			'zitadel-machine-key-eso-accessor',
			{
				secretId: machineKeySecret.secretId,
				project: gcp.projectId,
				role: 'roles/secretmanager.secretAccessor',
				member: pulumi.interpolate`serviceAccount:${gcp.esoServiceAccountEmail}`,
			},
		)
	}
}

// 4. GitHub Repository Environments (All Environments)
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
