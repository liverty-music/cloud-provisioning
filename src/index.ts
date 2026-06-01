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
// PostHog Cloud EU public project API key, sourced via `esc env set
// liverty-music/<env> pulumiConfig.posthogProjectApiKey "phc_..." --secret`.
// Conditionally seeds a GSM secret read by the backend analytics-consumer
// via ESO. When unset, the backend's nil-client mode logs and acks each
// USER.created event without forwarding (local-dev convention).
const posthogProjectApiKey = config.getSecret('posthogProjectApiKey')
// Gemini API direct backend key for the concert searcher workload. REQUIRED
// post-#303: the two-step grounded-extract pipeline needs URLContext +
// TimeRangeFilter, which Vertex AI does not support. `gemini.NewConcertSearcher`
// fails fast when the env var is empty, so this secret SHALL be set in every
// stack where the backend workload runs (dev / prod).
const geminiSearchApiKey = config.getSecret('geminiSearchApiKey')
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

// Workload tier gate. When false (dev shutdown mode), skip the
// in-cluster Zitadel orchestrator, GSM bootstrap secret shells, and
// (inside `Gcp`) GKE + Cloud SQL + Monitoring. Defaults to `true` so
// prod and active dev need no extra config. See
// docs/runbooks/dev-shutdown-restart.md.
//
// The flag is **dev-only** — a `workloadEnabled: "false"` accidentally
// committed to `Pulumi.prod.yaml`, leaked via ESC, or introduced by
// PR drift would otherwise turn this cost-shutdown switch into a prod
// destruction button. Fail loudly at the program-construct phase so
// the misconfiguration is impossible to apply silently (the
// `pulumi up` job will abort before computing any resource diff).
// Disabling prod requires a deliberate code change, not a config flip.
const workloadEnabled = config.getBoolean('workloadEnabled') ?? true

// Cloud SQL availability tier. Default `ZONAL` so new stacks land in the
// cost-priority configuration; promote to `REGIONAL` per stack by setting
// `liverty-music:postgresAvailabilityType: REGIONAL` in `Pulumi.<env>.yaml`
// once an HA SLA is required. See the `database` capability spec for the
// staged-rollout policy and the `prod-cost-optimization` change for the
// motivation. Validation is intentionally narrow (string literal pair) so
// a typo fails at program-construct time, not at Cloud SQL API time.
const postgresAvailabilityTypeRaw =
	config.get('postgresAvailabilityType') ?? 'ZONAL'
if (
	postgresAvailabilityTypeRaw !== 'ZONAL' &&
	postgresAvailabilityTypeRaw !== 'REGIONAL'
) {
	throw new Error(
		`liverty-music:postgresAvailabilityType must be 'ZONAL' or 'REGIONAL', ` +
			`got '${postgresAvailabilityTypeRaw}'.`,
	)
}
const postgresAvailabilityType = postgresAvailabilityTypeRaw as
	| 'ZONAL'
	| 'REGIONAL'
// Allow-list rather than block-list: any stack other than `dev`
// (today `prod`; tomorrow `staging` if added to `Environment`) is
// implicitly off-limits to the shutdown switch. Adding a new
// shut-down-capable env requires deliberately listing it here.
if (env !== 'dev' && !workloadEnabled) {
	throw new Error(
		`workloadEnabled=false is forbidden in the '${env}' stack. ` +
			'This flag is a dev-only cost-shutdown switch — see ' +
			'docs/runbooks/dev-shutdown-restart.md. To disable a non-dev ' +
			'workload tier, make a deliberate code change rather than ' +
			'flipping this flag.',
	)
}

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
// Skipped when `workloadEnabled=false`: the Zitadel orchestrator talks
// to the in-cluster Zitadel API which is unreachable while the cluster
// is destroyed (dev shutdown mode).
const zitadel = workloadEnabled
	? new Zitadel('liverty-music', {
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
			pannpersGoogleSub: zitadelConfig.apply(
				(z) => z.adminGoogleSubs.pannpers,
			),
			// E2E test user password — only consumed when `env === 'dev'` inside
			// the unified class; the class's `if (env === 'dev')` gate validates
			// presence at instantiation time.
			e2eTestUserPassword:
				env === 'dev'
					? zitadelConfig.apply((z) => z.e2eTestUser.password)
					: undefined,
		})
	: undefined
const zitadelMachineKey = zitadel?.machineKeyDetails
const zitadelLoginPat = zitadel?.loginClientToken

// 2. GCP Infrastructure (All Environments)
const gcp = new Gcp({
	brandId,
	displayName,
	environment: env,
	gcpConfig,
	lastFmApiKey,
	fanartTvApiKey,
	posthogProjectApiKey,
	geminiSearchApiKey,
	blockchainConfig,
	cloudflareConfig,
	postmarkConfig,
	zitadelMachineKey,
	zitadelLoginPat,
	workloadEnabled,
	postgresAvailabilityType,
})

// 5. Self-hosted Zitadel GSM secret shells (all envs, always).
// Provisions the `zitadel-masterkey` + `zitadel-machine-key-for-pulumi-admin`
// Secret containers that the in-cluster Zitadel pod's bootstrap sidecar
// populates on first boot. The containers are unconditional so the
// masterkey RandomString (which encrypts Cloud SQL Zitadel data) and any
// bootstrap-uploaded admin SA key version survive a
// `workloadEnabled=false` cycle — destroying them and regenerating on
// restart would corrupt the preserved Cloud SQL data (the new masterkey
// can't decrypt rows written under the old one).
//
// `gcp.workloadSAs` (cluster Workload Identity SAs) is optional and gates
// only the IAM bindings inside `SecretsComponent`; the Secret + Version
// resources are created regardless.
new SecretsComponent('zitadel-secrets', {
	project: gcp.project,
	workloadSAs: gcp.workloadSAs,
})

// 3. GitHub Repository Environments (All Environments)
const sharedVariables = {
	REGION: gcp.region,
	PROJECT_ID: gcp.projectId,
	WORKLOAD_IDENTITY_PROVIDER: gcp.githubWorkloadIdentityProvider,
	SERVICE_ACCOUNT: gcp.githubActionsSAEmail,
}

// Shared org CI-automation GitHub App credential (`liverty-music-ci-bot`).
// Wired onto the backend + frontend `prod` environments so the
// `dispatch-prod-pin` job can mint an installation token (scoped to
// cloud-provisioning) and POST the `bump-prod-pin` `repository_dispatch`.
// Prod-only and optional: absent until the App is created and its credential
// is set in ESC (`pulumiConfig.github.ciBotAppId` / `...PrivateKey`). The
// secret is intentionally kept on the consuming repos' `prod` environments
// (not org-wide) so a compromised non-prod workflow cannot mint the token.
// See docs/runbooks/prod-image-tag-pinning.md "Automation setup" §1.
const ciBotSecrets =
	env === 'prod' && githubConfig.ciBotAppId && githubConfig.ciBotAppPrivateKey
		? {
				CI_BOT_APP_ID: githubConfig.ciBotAppId,
				CI_BOT_APP_PRIVATE_KEY: githubConfig.ciBotAppPrivateKey,
			}
		: undefined

// Backend Repository
new GitHubRepositoryComponent({
	brandId,
	githubConfig,
	repositoryName: RepositoryName.BACKEND,
	environment: env,
	variables: sharedVariables,
	secrets: ciBotSecrets,
	requiredStatusCheckContexts: ['CI Success'],
})

// Frontend Repository
new GitHubRepositoryComponent({
	brandId,
	githubConfig,
	repositoryName: RepositoryName.FRONTEND,
	environment: env,
	variables: sharedVariables,
	secrets: ciBotSecrets,
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
	// Prod-only (repo-level vars are repo-global, so only one stack may own
	// them): the `bump-prod-pin.yml` `repository_dispatch` path runs with an
	// empty `environment:` and reads the prod WIF provider + SA from these
	// repository-level variables to authenticate `crane` for the provenance
	// gate against prod AR.
	repositoryVariables:
		env === 'prod'
			? {
					WORKLOAD_IDENTITY_PROVIDER:
						gcp.githubWorkloadIdentityProvider,
					SERVICE_ACCOUNT: gcp.githubActionsSAEmail,
				}
			: undefined,
	// Admin-reviewer gate for the `bump-prod-pin.yml` manual recovery path.
	pinBumpReviewerUsername: env === 'prod' ? 'pannpers' : undefined,
	// Express prod `main` protection as a ruleset so `github-actions[bot]` can
	// bypass it to push the automated pin-bump (the only mechanism that bypasses
	// the strict up-to-date check). Bypass scoped to the Actions app only.
	mainBranchBotBypass: true,
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
//
// Emit the `DEV_SHUTDOWN_SENTINEL` placeholder instead of `undefined`
// while `workloadEnabled=false` (dev shutdown mode). Two Pulumi
// behaviors interact here and both bite the naive `?.` chain:
//
//   1. `undefined` exports are omitted from the stack output
//      registry entirely — `pulumi stack output webFrontendClientId`
//      hard-fails with "Output not found" rather than returning a
//      falsy value, breaking frontend CI steps that don't `--json`-
//      guard the call.
//   2. Empty-string exports are *also* treated as absent by Pulumi's
//      preview/diff display (and by some `pulumi stack output`
//      paths), so a `?? ''` fallback would not solve (1) reliably.
//
// A non-empty, recognizable sentinel keeps the output key present
// in every state and signals intent to the consumer ("dev is down,
// fall back to cached `.env.dev` or skip the build"). Frontend CI
// must check for this exact string before treating the value as a
// usable OIDC client id.
// Exported so frontend CI consumers can import the canonical
// value (`import { DEV_SHUTDOWN_SENTINEL } from '...'` or read it
// via `pulumi stack output DEV_SHUTDOWN_SENTINEL`) rather than
// hardcoding the literal string. The trade-off is that the
// constant lands as a stack output on every stack including prod,
// where it has no purpose — accepted because consumer-side type
// safety > one redundant prod output key. The name's `DEV_` prefix
// makes the intent obvious to anyone introspecting prod outputs.
// See docs/runbooks/dev-shutdown-restart.md gotcha table for the
// consumer contract.
export const DEV_SHUTDOWN_SENTINEL = 'DEV_SHUTDOWN_workloadEnabled=false'
export const webFrontendClientId: string | pulumi.Output<string> =
	zitadel?.frontend.application.clientId ?? DEV_SHUTDOWN_SENTINEL
export const productOrgId: string | pulumi.Output<string> =
	zitadel?.productOrg.id ?? DEV_SHUTDOWN_SENTINEL
