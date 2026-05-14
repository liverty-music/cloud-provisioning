import * as gcpProvider from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as zitadelProvider from '@pulumiverse/zitadel'
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
import { BackendMachineKeyComponent } from './zitadel/components/backend-machine-key.js'
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

// 4. Zitadel Identity (self-hosted, dev only post-cutover).
// Provider points at `https://auth.dev.liverty-music.app`; admin SA key is
// pulled from GSM `zitadel-machine-key-for-pulumi-admin` (populated once by the in-cluster
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
		// `zitadelConfig` is `pulumi.Output<{ googleAdminIdp: ... }>` because
		// `requireSecretObject` marks the entire object as secret. Both
		// derived values are therefore secret-marked Outputs in Pulumi state.
		googleAdminIdpClientId: zitadelConfig.apply(
			(z) => z.googleAdminIdp.clientId,
		),
		googleAdminIdpClientSecret: zitadelConfig.apply(
			(z) => z.googleAdminIdp.clientSecret,
		),
		pannpersGoogleSub: zitadelConfig.apply(
			(z) => z.adminGoogleSubs.pannpers,
		),
		e2eTestUserPassword: zitadelConfig.apply((z) => z.e2eTestUser.password),
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

// 5. Self-hosted Zitadel infra phase (dev + prod).
// Provisions GSM secret shells (masterkey, empty admin-sa-key) that the
// in-cluster Zitadel pod's bootstrap sidecar will populate on first boot.
// The cutover PR reads `zitadel-machine-key-for-pulumi-admin` from GSM to reconfigure the
// Zitadel Pulumi provider at the self-hosted hostname. Always running this
// phase (even before cutover) is safe: the secret shells don't affect the
// Cloud-tenant Zitadel resources above.
if (env === 'dev' || env === 'prod') {
	new SecretsComponent('zitadel-secrets', {
		project: gcp.project,
		zitadelServiceAccountEmail: gcp.zitadelServiceAccountEmail,
		esoServiceAccountEmail: gcp.esoServiceAccountEmail,
	})
}

// 6. Prod self-hosted Zitadel: backend MachineUser + key + GSM bundle.
// This block closes the gap discovered post-`prod-k8s-manifests` deploy:
// the `Zitadel` class above is dev-only (SaaS Cloud-tenant), so prod's
// `pulumi up` never created `zitadel-machine-key-for-backend-app` and the
// backend Pods sat in `ContainerCreating`. The fix is a focused
// `BackendMachineKeyComponent` that:
//   1. Reads the admin JWT from the GSM Secret populated by the in-cluster
//      bootstrap-uploader sidecar on first Zitadel API Pod boot (design D3).
//      The JWT value never round-trips through Pulumi config or ESC.
//   2. Looks up the first-boot "admin" org via the Zitadel data source
//      (design D2). Pulumi does NOT create the org — it was auto-created
//      by `ZITADEL_FIRSTINSTANCE_ORG_NAME` and owning it would create a
//      destroy-cascade hazard.
//   3. Creates the prod backend `MachineUser` + `MachineKey` + `OrgMember`
//      (via the existing `MachineUserComponent`) and writes the resulting
//      JWT-profile to a SEPARATE GSM Secret `zitadel-machine-key-for-backend-app`
//      that the backend Pod mounts via ESO.
//
// Blast-radius separation preserved: the org-admin JWT is consumed only by
// Pulumi at plan/apply time; runtime Pods only mount the derived
// lower-privilege MachineKey JWT (per `prod-k8s-manifests` round-12 fix).
if (env === 'prod') {
	const prodProject = `${brandId}-${env}` // liverty-music-prod
	const adminJwt = gcpProvider.secretmanager.getSecretVersionAccessOutput({
		project: prodProject,
		secret: 'zitadel-machine-key-for-pulumi-admin',
	})

	const zitadelProdProvider = new zitadelProvider.Provider('zitadel-prod', {
		domain: 'auth.liverty-music.app',
		insecure: false,
		port: '443',
		jwtProfileJson: adminJwt.secretData,
	})

	// Look up the first-boot "admin" org by name. The Zitadel provider's
	// data source supports name-based query via `getOrgs` (plural) returning
	// `ids: string[]`; assert exactly one match before using it (design
	// risk-mitigation note: lookup must be unambiguous).
	const adminOrgs = zitadelProvider.getOrgsOutput(
		{
			name: 'admin',
			nameMethod: 'TEXT_QUERY_METHOD_EQUALS',
			state: 'ORG_STATE_ACTIVE',
		},
		{ provider: zitadelProdProvider },
	)

	const adminOrgId = adminOrgs.apply((result) => {
		if (!result.ids || result.ids.length === 0) {
			throw new Error(
				"zitadel.getOrgs returned zero ACTIVE orgs named 'admin' against " +
					'auth.liverty-music.app. Expected the first-boot bootstrap to have ' +
					'created this org. Check Zitadel API logs and `ZITADEL_FIRSTINSTANCE_ORG_NAME`.',
			)
		}
		if (result.ids.length > 1) {
			throw new Error(
				`zitadel.getOrgs returned ${result.ids.length} orgs named 'admin' ` +
					`(ids: ${result.ids.join(', ')}). Expected exactly one — refuse ` +
					'to guess which is the first-boot org. Inspect Zitadel and either ' +
					'delete the stale orgs or switch this lookup to a unique discriminator.',
			)
		}
		return result.ids[0]
	})

	new BackendMachineKeyComponent('backend-app-prod', {
		env,
		gcpProject: prodProject,
		zitadelProvider: zitadelProdProvider,
		orgId: adminOrgId,
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
