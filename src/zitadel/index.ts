import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../config.js'
import { ActionsV2Component } from './components/actions-v2.js'
import { AdminOrgConfigComponent } from './components/admin-org-config.js'
import { FrontendComponent } from './components/frontend.js'
import { GoogleAdminIdpComponent } from './components/google-admin-idp.js'
import { HumanAdminComponent } from './components/human-admin.js'
import { LoginClientComponent } from './components/login-client.js'
import { MachineUserComponent } from './components/machine-user.js'
import { SmtpComponent } from './components/smtp.js'
import {
	BACKEND_WEBHOOK_BASE_URL,
	PRE_ACCESS_TOKEN_PATH,
	ZITADEL_DEV_ADMIN_ORG_ID,
	zitadelDomainMap,
} from './constants.js'

export * from './components/actions-v2.js'
export * from './components/admin-org-config.js'
export * from './components/frontend.js'
export * from './components/google-admin-idp.js'
export * from './components/human-admin.js'
export * from './components/login-client.js'
export * from './components/machine-user.js'
export * from './components/secrets.js'
export * from './components/smtp.js'
export * from './constants.js'
export * from './dynamic/index.js'

export interface ZitadelArgs {
	env: Environment
	/** GCP project ID (e.g. `liverty-music-dev`) holding the GSM secret
	 *  `zitadel-admin-sa-key` populated by the in-cluster bootstrap-uploader. */
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
}

/**
 * Zitadel orchestrates all Zitadel identity resources against the
 * in-cluster self-hosted Zitadel instance reachable at the env-specific
 * issuer hostname (e.g. `https://auth.dev.liverty-music.app` for dev).
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
 *   `zitadel.Org('liverty-music', { isDefault: true })`. Hosts product
 *   resources and end-user identities only: the `liverty-music` Project,
 *   the frontend `ApplicationOidc`, the passkey-only end-user
 *   `LoginPolicy`, the `backend-app` machine user (used by the backend
 *   Go service to call Zitadel Management APIs), and future fan
 *   accounts.
 *
 * Pulumi authenticates as `pulumi-admin` (admin org), reads the JWT
 * profile JSON from GSM `zitadel-admin-sa-key`, and provisions
 * everything else from there.
 *
 * Cutover scope is dev-only. Staging / prod adoption is a separate
 * change; the `env` guard below makes a staging / prod attempt fail
 * loudly until those environments get their own
 * `ZITADEL_<ENV>_ADMIN_ORG_ID`, configmap with
 * `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin`, and Google OAuth client wired
 * through Pulumi ESC.
 */
export class Zitadel {
	public readonly provider: zitadel.Provider
	public readonly productOrg: zitadel.Org
	public readonly project: zitadel.Project
	public readonly frontend: FrontendComponent
	public readonly smtp: SmtpComponent
	public readonly actionsV2: ActionsV2Component
	public readonly machineUser: MachineUserComponent
	public readonly loginClient: LoginClientComponent
	public readonly googleAdminIdp: GoogleAdminIdpComponent
	public readonly adminOrgConfig: AdminOrgConfigComponent
	public readonly humanAdmin: HumanAdminComponent

	/** JWT profile JSON for the backend-app machine user. Store in Secret Manager. */
	public readonly machineKeyDetails: pulumi.Output<string>

	/** Personal Access Token for the zitadel-login (Login V2 UI) container.
	 *  Store in Secret Manager and mount via ExternalSecret as a file
	 *  (consumed by `ZITADEL_SERVICE_USER_TOKEN_FILE`). */
	public readonly loginClientToken: pulumi.Output<string>

	constructor(name: string, args: ZitadelArgs) {
		const {
			env,
			gcpProjectId,
			postmarkServerApiToken,
			googleAdminIdpClientId,
			googleAdminIdpClientSecret,
		} = args

		if (env !== 'dev') {
			// Self-hosted Zitadel + two-org admin topology is dev-only.
			// Extending to staging / prod requires:
			//   - An env-keyed admin-org-id source (constants.ts or a Dynamic
			//     Resource that discovers it from the admin SA key).
			//   - A bootstrapped self-hosted instance with admin-sa-key in
			//     that environment's GSM, with
			//     ZITADEL_FIRSTINSTANCE_ORG_NAME=admin in the configmap.
			//   - Per-env Google OAuth client + ESC config.
			//   - A separate cutover PR per environment.
			throw new Error(
				`Zitadel self-hosted topology is dev-only; got env=${env}. ` +
					'See OpenSpec change "add-zitadel-console-admin-via-google-idp" ' +
					'for the staging/prod adoption plan.',
			)
		}

		const adminOrgId = ZITADEL_DEV_ADMIN_ORG_ID
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
					secret: 'zitadel-admin-sa-key',
					version: 'latest',
				})
				.apply((v) => v.secretData),
		)

		this.provider = new zitadel.Provider(`${name}-provider`, {
			domain,
			jwtProfileJson,
		})

		// Product org — Pulumi-managed, marked Zitadel default org so that
		// OIDC AuthN requests without an explicit org_id (e.g. the frontend
		// SPA's auth flow) route to it. `isDefault: true` here flips the
		// instance default away from the bootstrap admin org, which
		// otherwise would carry the default flag.
		this.productOrg = new zitadel.Org(
			'liverty-music',
			{
				name: 'liverty-music',
				isDefault: true,
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
				// Use default private labeling to avoid potential policy conflicts with instance SMTP
				privateLabelingSetting: 'PRIVATE_LABELING_SETTING_UNSPECIFIED',
			},
			{ provider: this.provider, dependsOn: [this.productOrg] },
		)

		this.frontend = new FrontendComponent(name, {
			env,
			orgId: this.productOrg.id,
			projectId: this.project.id,
			provider: this.provider,
		})

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
			orgId: adminOrgId,
			provider: this.provider,
		})

		this.loginClientToken = this.loginClient.token

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
			adminOrgId,
			googleIdpId: this.googleAdminIdp.idp.id,
			provider: this.provider,
		})

		// Human admin user (pannpers@pannpers.dev) in the admin org, with
		// IAM_OWNER granted at instance level. First Google sign-in auto-
		// links the IdP identity to this user via the Google IdP's
		// `isLinkingAllowed` setting.
		this.humanAdmin = new HumanAdminComponent(name, {
			adminOrgId,
			email: 'pannpers@pannpers.dev',
			firstName: 'Kyosuke',
			lastName: 'Hamada',
			provider: this.provider,
		})
	}
}
