import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../config.js'
import { ActionsV2Component } from './components/actions-v2.js'
import {
	ADMIN_CONSOLE_ROLE_ADMIN,
	AdminConsoleComponent,
} from './components/admin-console.js'
import { AdminOrgConfigComponent } from './components/admin-org-config.js'
import { E2eTestUserComponent } from './components/e2e-test-user.js'
import { FrontendComponent } from './components/frontend.js'
import { GoogleAdminIdpComponent } from './components/google-admin-idp.js'
import { HumanAdminComponent } from './components/human-admin.js'
import { LoginClientComponent } from './components/login-client.js'
import { MachineUserComponent } from './components/machine-user.js'
import { SmtpComponent } from './components/smtp.js'
import { WatchdogProbeComponent } from './components/watchdog-probe.js'
import {
	adminOrgIdMap,
	BACKEND_WEBHOOK_BASE_URL,
	LOGIN_EVENT_PATH,
	PRE_ACCESS_TOKEN_PATH,
	zitadelDomainMap,
} from './constants.js'
import { ZitadelHostedLoginTranslation } from './dynamic/index.js'

/**
 * Complete Japanese Hosted Login translation payload, pinned from upstream
 * `zitadel/zitadel apps/login/locales/ja.json` at the deployed login version
 * (`v4.14.0`). Seeded via `ZitadelHostedLoginTranslation` because Zitadel's
 * backend defaults omit Japanese, so the Settings API otherwise returns English
 * for `ja` and the Login UI v2 renders the Japanese login in English. MUST stay
 * complete (the API English-fills omitted keys). Re-sync on Zitadel upgrades;
 * remove once upstream `v2-default.json` ships Japanese. See OpenSpec change
 * `fix-zitadel-login-ja-i18n`.
 */
const jaLoginTranslationJson = readFileSync(
	fileURLToPath(new URL('./translations/ja.json', import.meta.url)),
	'utf-8',
)

/**
 * Complete English Hosted Login translation payload, pinned from upstream
 * `zitadel/zitadel apps/login/locales/en.json` at the deployed login version
 * (`v4.14.0`), with the product-org rebrand applied: `register.description`
 * and `common.title` drop the literal "Zitadel" in favor of "Liverty Music".
 *
 * Unlike `ja`, English is NOT a missing-language case — the Settings API
 * already returns English. We still seed the COMPLETE payload (rather than a
 * partial 2-key override) because `SetHostedLoginTranslation` English-fills
 * omitted keys from the backend `v2-default.json` and the Login UI v2 then
 * shadows its bundled `en.json` with that API result. A partial override would
 * therefore let backend-default English (which can lag the login app's bundled
 * `en.json`) silently replace every un-supplied key. Pinning the login app's
 * own `en.json` keeps all other strings byte-identical to what the image
 * bundles, so only the two rebranded keys change. Re-sync on Zitadel upgrades.
 */
const enLoginTranslationJson = readFileSync(
	fileURLToPath(new URL('./translations/en.json', import.meta.url)),
	'utf-8',
)

export * from './components/actions-v2.js'
export * from './components/admin-console.js'
export * from './components/admin-org-config.js'
export * from './components/e2e-test-user.js'
export * from './components/frontend.js'
export * from './components/google-admin-idp.js'
export * from './components/human-admin.js'
export * from './components/login-client.js'
export * from './components/machine-user.js'
export * from './components/secrets.js'
export * from './components/smtp.js'
export * from './components/watchdog-probe.js'
export * from './constants.js'
export * from './dynamic/index.js'

export interface ZitadelArgs {
	env: Environment
	/** GCP project ID (e.g. `liverty-music-dev`) holding the GSM secret
	 *  `zitadel-machine-key-for-pulumi-admin` populated by the in-cluster
	 *  bootstrap-uploader. */
	gcpProjectId: pulumi.Input<string>
	/** Postmark Server API Token — used as both SMTP username and password. */
	postmarkServerApiToken: string
	/** Google OAuth 2.0 Web Application client_id for the admin Google IdP.
	 *  Sourced from Pulumi config `zitadel:googleAdminIdp.clientId` (ESC
	 *  `pulumiConfig.zitadel.googleAdminIdp.clientId`). */
	googleAdminIdpClientId: pulumi.Input<string>
	/** Google OAuth 2.0 Web Application client_secret for the admin Google
	 *  IdP. Sourced from Pulumi config
	 *  `zitadel:googleAdminIdp.clientSecret` (ESC
	 *  `pulumiConfig.zitadel.googleAdminIdp.clientSecret`, marked secret).
	 *  MUST be passed wrapped in `pulumi.secret()` upstream. */
	googleAdminIdpClientSecret: pulumi.Input<string>
	/**
	 * Google OIDC `sub` claim for the human admin (`pannpers@pannpers.dev`).
	 * Sourced from ESC `pulumiConfig.zitadel.adminGoogleSubs.pannpers`.
	 * Stable numeric string per Google account; consumed by
	 * `ZitadelUserIdpLink` to pre-link the Google identity to the local
	 * `pannpers` HumanUser so first-sign-in on `/ui/console` works without
	 * userLogin or auto-creation.
	 */
	pannpersGoogleSub: pulumi.Input<string>
	/**
	 * Initial password for the dev-only Playwright E2E test user.
	 * Sourced from ESC `pulumiConfig.zitadel.e2eTestUser.password`
	 * (secret). Consumed by `E2eTestUserComponent`. See OpenSpec
	 * change `playwright-password-test-user` for rationale.
	 *
	 * Required only when `env === 'dev'`. Other envs do not provision
	 * the E2E test user; this arg is ignored.
	 */
	e2eTestUserPassword?: pulumi.Input<string>
}

/**
 * Zitadel orchestrates all Zitadel identity resources against the
 * in-cluster self-hosted Zitadel instance reachable at the env-specific
 * issuer hostname (`https://auth.dev.liverty-music.app` for dev,
 * `https://auth.liverty-music.app` for prod).
 *
 * ## Two-org topology
 *
 * Per OpenSpec change `add-zitadel-console-admin-via-google-idp`, the
 * instance is split into two orgs by responsibility:
 *
 * - **`admin` role org** — created by Zitadel at first-instance bootstrap
 *   because the configmap sets `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin`.
 *   Hosts operator identities only: `pulumi-admin` (machine, IaC and
 *   break-glass), `login-client` (machine, Login V2 PAT), and human
 *   admins like `pannpers@pannpers.dev` (Google SSO via instance-level
 *   IdP). Holds an explicit `LoginPolicy` that disables username +
 *   password sign-in and exposes the Google IdP.
 *
 * - **`liverty-music` product org** — created by Pulumi as
 *   `zitadel.Org('liverty-music', { isDefault: false })`. Hosts product
 *   resources and end-user identities only: the `liverty-music` Project,
 *   the frontend `ApplicationOidc`, the passkey-only end-user
 *   `LoginPolicy`, the `backend-app` machine user (used by the backend
 *   Go service to call Zitadel Management APIs), and future fan
 *   accounts.
 *
 * Pulumi authenticates as `pulumi-admin` (admin org), reads the JWT
 * profile JSON from GSM `zitadel-machine-key-for-pulumi-admin`, and
 * provisions everything else from there.
 *
 * ## All-envs unified class (refactor-unify-env-dispatch)
 *
 * This class is the **single source of truth** for the Zitadel topology
 * across all envs. Previously two parallel "prod-only" wrapper classes
 * (`BackendMachineKeyComponent` from `enable-zitadel-prod-pulumi-provider`
 * and `ZitadelProdStackComponent` from `complete-zitadel-prod-pulumi-stack`)
 * cloned this assembly for prod with subset config — that pattern was
 * retired in `refactor-unify-env-dispatch` for being drift-prone and
 * fighting the env-aware leaf-component grain. Env-specific values
 * (admin org id, redirect URIs, sender address) are sourced from
 * `Record<Environment, T>` maps in `constants.ts` and downstream
 * leaf components.
 *
 * The only env-conditional resource at this layer is `E2eTestUserComponent`,
 * which is dev-only by product decision (not env-dispatch anti-pattern):
 * E2E test infrastructure is dev-scoped per `playwright-password-test-user`
 * and `enable-zitadel-prod-e2e-user` (the future change planning prod
 * adoption).
 */
export class Zitadel {
	public readonly provider: zitadel.Provider
	/** Instance-level OIDC token lifetimes (access 30m, refresh idle 30d,
	 *  refresh absolute 90d). */
	public readonly defaultOidcSettings: zitadel.DefaultOidcSettings
	public readonly adminOrg: zitadel.Org
	public readonly productOrg: zitadel.Org
	public readonly project: zitadel.Project
	public readonly frontend: FrontendComponent
	/** Internal admin console OIDC surface in the admin role org. */
	public readonly adminConsole: AdminConsoleComponent
	/** Japanese Hosted Login translation override for the product org. */
	public readonly jaLoginTranslation: ZitadelHostedLoginTranslation
	/** English Hosted Login translation override for the product org
	 *  (carries the "Liverty Music" rebrand of the login/register copy). */
	public readonly enLoginTranslation: ZitadelHostedLoginTranslation
	public readonly smtp: SmtpComponent
	public readonly actionsV2: ActionsV2Component
	public readonly machineUser: MachineUserComponent
	public readonly loginClient: LoginClientComponent
	public readonly googleAdminIdp: GoogleAdminIdpComponent
	public readonly adminOrgConfig: AdminOrgConfigComponent
	public readonly humanAdmin: HumanAdminComponent
	public readonly adminRoleGrant: zitadel.UserGrant
	/** E2E test user — dev-only. `undefined` in prod (and any future env). */
	public readonly e2eTestUser: E2eTestUserComponent | undefined

	/** Watchdog probe machine user + PAT for the self-healing CronJob. */
	public readonly watchdogProbe: WatchdogProbeComponent

	/** JWT profile JSON for the backend-app machine user. Store in Secret Manager. */
	public readonly machineKeyDetails: pulumi.Output<string>

	/** Personal Access Token for the zitadel-login (Login V2 UI) container.
	 *  Store in Secret Manager and mount via ExternalSecret as a file
	 *  (consumed by `ZITADEL_SERVICE_USER_TOKEN_FILE`). */
	public readonly loginClientToken: pulumi.Output<string>

	/** Personal Access Token for the watchdog CronJob bearer token.
	 *  Store in Secret Manager and sync to the `zitadel` namespace via ExternalSecret. */
	public readonly watchdogProbeToken: pulumi.Output<string>

	constructor(name: string, args: ZitadelArgs) {
		const {
			env,
			gcpProjectId,
			postmarkServerApiToken,
			googleAdminIdpClientId,
			googleAdminIdpClientSecret,
			pannpersGoogleSub,
			e2eTestUserPassword,
		} = args

		const domain = zitadelDomainMap[env]

		// Pull the bootstrap-uploaded admin machine user JWT-profile JSON from
		// GSM. `secretData` is a `pulumi.Output<string>` that resolves at
		// preview/up time via the GCP Secret Manager API — no Pulumi-graph
		// dependency on `SecretsComponent` is needed (the secret is created
		// by SecretsComponent and populated out-of-band by the bootstrap
		// sidecar; we only read the latest version here).
		//
		// CRITICAL: wrap the result in `pulumi.secret()` so Pulumi marks the
		// value `[secret]` in state and preview output. Without this, the RSA
		// private key embedded in the JWT-profile JSON leaks into preview
		// logs, CI output, and Pulumi service history.
		const jwtProfileJson = pulumi.secret(
			gcp.secretmanager
				.getSecretVersionOutput({
					project: gcpProjectId,
					secret: 'zitadel-machine-key-for-pulumi-admin',
					version: 'latest',
				})
				.apply((v) => v.secretData),
		)

		this.provider = new zitadel.Provider(`${name}-provider`, {
			domain,
			jwtProfileJson,
		})

		// Instance-level OIDC token lifetimes. Previously unset, so all OIDC
		// apps in the instance (frontend SPA, admin console) ran on Zitadel's
		// built-in defaults (access 12h). Pinning these makes the intent durable
		// and reviewable: a 30m access token shrinks the revocation-relevant
		// exposure window, while the long refresh window (idle 30d / absolute
		// 90d, matching the prior defaults) keeps fans signed in across gaps.
		// All four fields are required inputs in @pulumiverse/zitadel ^0.2.0.
		// See OpenSpec change `extend-auth-session-lifetime`.
		this.defaultOidcSettings = new zitadel.DefaultOidcSettings(
			`${name}-oidc-settings`,
			{
				accessTokenLifetime: '0h30m0s',
				// Keep Zitadel's default — the ID token is refreshed alongside the
				// access token on silent renew, so there is no need to shorten it.
				idTokenLifetime: '12h0m0s',
				refreshTokenExpiration: '2160h0m0s', // 90d (absolute)
				refreshTokenIdleExpiration: '720h0m0s', // 30d (idle)
			},
			{ provider: this.provider },
		)

		// Admin role org — bootstrap-created (`ZITADEL_FIRSTINSTANCE_ORG_NAME=
		// admin` in configmap), brought into Pulumi state via a one-time
		// `pulumi import zitadel:index/org:Org admin <admin-org-id>` so the
		// `isDefault` flag and downstream config are reviewable in git.
		// `protect: true` is critical because `pulumi destroy` against this
		// resource would lock everyone out: the bootstrap-created
		// `pulumi-admin` machine user (which the @pulumiverse/zitadel provider
		// authenticates as) lives inside it.
		//
		// Why admin must be the default org (not liverty-music): empirically
		// verified in dev (Console deployment 282 follow-up) — the Zitadel
		// Console's OIDC AuthN does not include an `org_id`, so Login V2 uses
		// the **default org's own LoginPolicy**. If `liverty-music` is
		// default, Console hits the product org's policy (passkey + register,
		// no IdPs) and the admin's Google sign-in button never appears.
		// Making `admin` the default routes Console to the admin org's
		// LoginPolicy (Google IdP + `userLogin = false`), which is the
		// intended path. End-user OIDC traffic from the frontend SPA is
		// unaffected because its `ApplicationOidc` client is owned by the
		// `liverty-music` Project (in the product org), and Zitadel resolves
		// the AuthN's `client_id` to that org regardless of the default flag.
		// See OpenSpec change `add-zitadel-console-admin-via-google-idp`,
		// design D8 update.
		this.adminOrg = new zitadel.Org(
			'admin',
			{
				name: 'admin',
				isDefault: true,
			},
			{
				provider: this.provider,
				protect: true,
				// Inline `import:` resource option (per `refactor-unify-env-dispatch`
				// D2 + spec scenario "Admin org imported via inline import:"). Pulumi
				// resolves this on first apply only; once the resource is in state,
				// the value is a no-op. Each env's bootstrap-created admin org id
				// is in `adminOrgIdMap` — dev's was imported via the legacy
				// `pulumi import` CLI before this field existed, so its first
				// apply post-refactor is the FIRST time Pulumi evaluates the
				// `import:` against existing state (should be a no-op match).
				import: adminOrgIdMap[env],
			},
		)

		// Product org — Pulumi-created. NOT the default org (admin is). The
		// frontend SPA's `ApplicationOidc` client below carries this org's
		// id, so end-user OIDC AuthN routes here automatically.
		this.productOrg = new zitadel.Org(
			'liverty-music',
			{
				name: 'liverty-music',
				isDefault: false,
			},
			{ provider: this.provider },
		)

		this.project = new zitadel.Project(
			name,
			{
				name: name,
				orgId: this.productOrg.id,
				// Minimal role settings for initial setup
				projectRoleAssertion: false,
				projectRoleCheck: false,
				hasProjectCheck: false,
				// Enforce the product org's own LabelPolicy (see
				// `FrontendComponent.labelPolicy`) for this app's login flow,
				// regardless of the logging-in user's resource-owner org. Zitadel
				// has no application-level label policy; this project setting is
				// the per-application control that selects which org's branding
				// the hosted Login UI v2 renders. The admin/console org login is
				// a separate org and stays unaffected. Supersedes the prior
				// defensive `UNSPECIFIED` (its SMTP-conflict caution was unrelated
				// to label policy). See OpenSpec change `brand-zitadel-login-ui`.
				privateLabelingSetting:
					'PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY',
			},
			{ provider: this.provider, dependsOn: [this.productOrg] },
		)

		this.frontend = new FrontendComponent(name, {
			env,
			orgId: this.productOrg.id,
			projectId: this.project.id,
			provider: this.provider,
		})

		// Internal admin console — its own project + ApplicationOidc in the
		// admin role org (a sibling of `frontend`, not a modification of it).
		// Authentication runs against the admin org's Google-Workspace
		// LoginPolicy (provisioned by `AdminOrgConfigComponent` below), which
		// is the access boundary. See OpenSpec change `add-admin-console`.
		this.adminConsole = new AdminConsoleComponent(name, {
			env,
			adminOrgId: this.adminOrg.id,
			provider: this.provider,
		})

		// Japanese Hosted Login translation override, scoped to the product
		// org. Zitadel's backend default hosted-login translations omit `ja`,
		// so the Settings API returns English for the `ja` locale and the
		// Login UI v2 merges that over its bundled Japanese — rendering the
		// Japanese login in English. Seeding the full Japanese payload here
		// makes the API return Japanese. Org-scoped so the admin/console org
		// login is unaffected. See OpenSpec change `fix-zitadel-login-ja-i18n`.
		this.jaLoginTranslation = new ZitadelHostedLoginTranslation(
			`${name}-ja-login-translation`,
			{
				domain,
				jwtProfileJson,
				organizationId: this.productOrg.id,
				locale: 'ja',
				translationsJson: jaLoginTranslationJson,
			},
		)

		// English Hosted Login translation override, also scoped to the product
		// org. English already resolves (it is the instance default language),
		// so this override exists purely to rebrand the login/register copy:
		// `register.description` and `common.title` drop the literal "Zitadel"
		// for "Liverty Music". The payload is the complete pinned `en.json` (see
		// `enLoginTranslationJson` doc) so only those two keys differ from the
		// login image's bundled English. Org-scoped, so the admin/console org
		// login keeps the upstream wording.
		this.enLoginTranslation = new ZitadelHostedLoginTranslation(
			`${name}-en-login-translation`,
			{
				domain,
				jwtProfileJson,
				organizationId: this.productOrg.id,
				locale: 'en',
				translationsJson: enLoginTranslationJson,
			},
		)

		this.smtp = new SmtpComponent(name, {
			env,
			serverApiToken: postmarkServerApiToken,
			provider: this.provider,
			domain,
			jwtProfileJson,
		})

		this.actionsV2 = new ActionsV2Component(name, {
			domain,
			jwtProfileJson,
			preAccessTokenEndpoint: `${BACKEND_WEBHOOK_BASE_URL}${PRE_ACCESS_TOKEN_PATH}`,
			loginEventEndpoint: `${BACKEND_WEBHOOK_BASE_URL}${LOGIN_EVENT_PATH}`,
			provider: this.provider,
		})

		// Product service machine user — backend-app calls Zitadel Management
		// APIs from the backend Go service. Lives in the product org per the
		// "Place Machine Users by Responsibility" requirement.
		this.machineUser = new MachineUserComponent(name, {
			orgId: this.productOrg.id,
			provider: this.provider,
		})

		this.machineKeyDetails = this.machineUser.keyDetails

		// Operator machine user — login-client hosts the Login V2 PAT. Lives
		// in the admin role org per the "Place Machine Users by
		// Responsibility" requirement.
		this.loginClient = new LoginClientComponent(name, {
			orgId: this.adminOrg.id,
			provider: this.provider,
		})

		this.loginClientToken = this.loginClient.token

		// Watchdog probe identity — least-privilege machine user in the product
		// org (co-located with the project it probes), granted PROJECT_OWNER_VIEWER
		// on the product project. The PAT is stored in GSM via
		// `zitadelWatchdogProbePat` (threaded through GcpArgs → KubernetesComponent
		// esoOnlySecrets) and synced to the `zitadel` namespace by an ExternalSecret.
		// See OpenSpec change `zitadel-watchdog-readonly-probe`.
		this.watchdogProbe = new WatchdogProbeComponent(name, {
			productOrgId: this.productOrg.id,
			productProjectId: this.project.id,
			provider: this.provider,
		})

		this.watchdogProbeToken = this.watchdogProbe.token

		// Instance-level Google IdP for human admin sign-in. The admin org's
		// LoginPolicy below references this IdP id; the product org's policy
		// does not, keeping end-user passkey-only sign-in unaffected.
		this.googleAdminIdp = new GoogleAdminIdpComponent(name, {
			clientId: googleAdminIdpClientId,
			clientSecret: googleAdminIdpClientSecret,
			provider: this.provider,
		})

		// Login policies on admin org + instance default. Both reference the
		// Google IdP so Console login surfaces the Google button regardless
		// of which routing path Login V2 takes.
		this.adminOrgConfig = new AdminOrgConfigComponent(name, {
			adminOrgId: this.adminOrg.id,
			googleIdpId: this.googleAdminIdp.idp.id,
			provider: this.provider,
		})

		// Human admin user (pannpers@pannpers.dev) in the admin org, with
		// IAM_OWNER granted at instance level. The Google identity is
		// pre-linked via `ZitadelUserIdpLink` (inside the component) so the
		// very first `/ui/console` sign-in resolves directly to this user
		// — required because the admin org's userLogin/auto-create policy
		// leaves no native first-link path. See
		// `dynamic/user-idp-link.ts` for the rationale.
		this.humanAdmin = new HumanAdminComponent(name, {
			adminOrgId: this.adminOrg.id,
			email: 'pannpers@pannpers.dev',
			firstName: 'Kyosuke',
			lastName: 'Hamada',
			googleIdpId: this.googleAdminIdp.idp.id,
			googleSub: pannpersGoogleSub,
			domain,
			jwtProfileJson,
			provider: this.provider,
		})

		// Grant the admin-console `admin` role to the human admin so their
		// access token carries the role claim the backend RBAC gate requires.
		// Lives here (not inside AdminConsoleComponent) because it joins two
		// siblings — the admin-console project and the human admin user — that
		// are constructed separately in this stack.
		this.adminRoleGrant = new zitadel.UserGrant(
			'admin-console-admin-grant',
			{
				orgId: this.adminOrg.id,
				projectId: this.adminConsole.project.id,
				userId: this.humanAdmin.humanUser.id,
				roleKeys: [ADMIN_CONSOLE_ROLE_ADMIN],
			},
			// `roleKeys` is a plain string constant, so Pulumi infers no
			// dependency on the ProjectRole that defines it — the grant could be
			// created before the role exists, which Zitadel rejects with
			// `Errors.Project.Role.NotFound`. Order the grant after the role.
			{
				provider: this.provider,
				dependsOn: [this.adminConsole.adminRole],
			},
		)

		// E2E test user — password-based HumanUser for Playwright headless
		// capture. Lives in `productOrg` to ride on the same end-user
		// LoginPolicy that real users hit; password sign-in only works
		// because `productOrg.loginPolicy.userLogin = true` (see
		// `components/frontend.ts` and the upstream Zitadel issue cited
		// there). See OpenSpec change `playwright-password-test-user`
		// for the full design + risk record, and `zitadel-permanent-password`
		// for the `ZitadelHumanUserPasswordPermanent` marker resource that
		// makes the user's password permanent at provision time.
		//
		// **Dev-only by product decision**, not env-dispatch anti-pattern:
		// prod E2E test infra is a separate concern tracked under the
		// future `enable-zitadel-prod-e2e-user` change. This is the one
		// remaining env-conditional resource in the unified class; per
		// `refactor-unify-env-dispatch` spec, env-conditional leaf
		// instantiation is acceptable when the leaf component is truly
		// env-scoped at the product layer.
		if (env === 'dev') {
			if (!e2eTestUserPassword) {
				throw new Error(
					'e2eTestUserPassword is required when env === "dev". ' +
						'Seed `pulumiConfig.zitadel.e2eTestUser.password` in dev ESC.',
				)
			}
			this.e2eTestUser = new E2eTestUserComponent(name, {
				env,
				orgId: this.productOrg.id,
				initialPassword: e2eTestUserPassword,
				domain,
				jwtProfileJson,
				provider: this.provider,
			})
		}
	}
}
