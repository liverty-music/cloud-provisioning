import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import {
	BACKEND_WEBHOOK_BASE_URL,
	PRE_ACCESS_TOKEN_PATH,
	zitadelDomainMap,
} from '../constants.js'
import { ActionsV2Component } from './actions-v2.js'
import { AdminOrgConfigComponent } from './admin-org-config.js'
import { BackendMachineKeyComponent } from './backend-machine-key.js'
import { FrontendComponent } from './frontend.js'
import { GoogleAdminIdpComponent } from './google-admin-idp.js'
import { HumanAdminComponent } from './human-admin.js'
import { LoginClientComponent } from './login-client.js'
import { SmtpComponent } from './smtp.js'

export interface ZitadelProdStackComponentArgs {
	/** Pulumi stack environment. Drives the Zitadel provider's `domain` and
	 *  several env-keyed maps (FrontendComponent redirect URIs,
	 *  SmtpComponent sender-address). The wrapper enforces `env === 'prod'`
	 *  to avoid accidental dev/staging instantiation; dev uses the existing
	 *  `Zitadel` class verbatim. */
	env: Environment
	/** GCP project that owns the admin JWT GSM Secret
	 *  `zitadel-machine-key-for-pulumi-admin` (read at plan time) and the
	 *  `zitadel-machine-key-for-backend-app` Secret the inner
	 *  `BackendMachineKeyComponent` creates. */
	gcpProject: pulumi.Input<string>
	/** Postmark Server API Token. Used as both SMTP username and password.
	 *  Sourced from ESC `pulumiConfig.postmark.serverApiToken`. */
	postmarkServerApiToken: string
	/** Google OAuth 2.0 Web Application client_id for the prod admin
	 *  Google IdP. Distinct from the dev client; sourced from
	 *  `pulumiConfig.zitadel.googleAdminIdp.clientId`. */
	googleAdminIdpClientId: pulumi.Input<string>
	/** Google OAuth 2.0 Web Application client_secret for the prod admin
	 *  Google IdP. MUST be passed wrapped in `pulumi.secret()` upstream;
	 *  sourced from `pulumiConfig.zitadel.googleAdminIdp.clientSecret`. */
	googleAdminIdpClientSecret: pulumi.Input<string>
	/** Google OIDC `sub` claim for the human admin (`pannpers@pannpers.dev`).
	 *  Same numeric value as dev (the sub is account-scoped). Sourced from
	 *  `pulumiConfig.zitadel.adminGoogleSubs.pannpers`. */
	pannpersGoogleSub: pulumi.Input<string>
}

/**
 * ZitadelProdStackComponent wraps the full Zitadel application stack for
 * the `prod` Pulumi stack into a single top-level ComponentResource so
 * that `src/index.ts` stays as a thin dispatch line (per CLAUDE.md "Main
 * entry point dispatching to GCP and GitHub components") while dev's
 * existing `Zitadel` class remains untouched — no URN churn on dev.
 *
 * ## Why not extend the dev `Zitadel` class?
 *
 * Loosening its `env !== 'dev'` guard or refactoring its arg shape would
 * force a Pulumi state migration on every dev URN underneath it. The
 * cost-benefit (one class vs. two) does not justify churning settled dev
 * state. This wrapper is a *parallel* assembly that re-uses every leaf
 * component file unchanged.
 *
 * ## Component dependency order
 *
 *   1. BackendMachineKeyComponent — creates `zitadel.Provider`,
 *      productOrg (`liverty-music`), backend `MachineUser` + `MachineKey`,
 *      `OrgMember`, and the `zitadel-machine-key-for-backend-app` GSM
 *      Secret + Version + ESO IAM binding. The provider + productOrg
 *      outputs flow into all 9 leaves below.
 *   2. adminOrg — `zitadel.Org('admin', { isDefault: true })`. Imported
 *      from existing bootstrap-created state via a one-time
 *      `pulumi import zitadel:index/org:Org admin <prod-admin-org-id>`.
 *      `protect: true` guards against `pulumi destroy` locking everyone
 *      out (the `pulumi-admin` MachineUser the provider authenticates as
 *      lives inside).
 *   3. project — `zitadel.Project('liverty-music')` in productOrg.
 *   4. frontend — `ApplicationOidc` + product-org `LoginPolicy`.
 *   5. smtp — Postmark `SmtpConfig` + dynamic `_activate` call.
 *   6. actionsV2 — `Target` + `Execution` on the `preaccesstoken` flow,
 *      injects the `email` claim into JWT access tokens before issuance.
 *   7. loginClient — admin-org `MachineUser` + instance `IAM_LOGIN_CLIENT`
 *      role + `PersonalAccessToken`. The PAT surfaces as
 *      `loginClientToken`, routed via `src/index.ts` into `Gcp`'s
 *      `esoOnlySecrets` to create the `zitadel-login-pat` GSM Secret
 *      (symmetric with the dev path).
 *   8. googleAdminIdp — instance-level Google IdP for operator sign-in.
 *      Keyed on a separate prod Google OAuth Web client (NOT the dev
 *      client) created out-of-band in Google Cloud Console.
 *   9. adminOrgConfig — admin-org `LoginPolicy` (`userLogin=false`,
 *      `idps=[googleIdpId]`) + instance `DefaultLoginPolicy` mirroring it.
 *  10. humanAdmin — `pannpers@pannpers.dev` `HumanUser` + instance
 *      `IAM_OWNER` `OrgMember` + dynamic `ZitadelUserIdpLink` pre-linking
 *      the prod Google identity to the local user (no auto-create / no
 *      userLogin in the admin org policy, so first sign-in needs a
 *      pre-existing link to succeed).
 *
 * E2eTestUserComponent is intentionally **out of scope** — prod E2E test
 * infra is deferred to a follow-up change (`enable-zitadel-prod-e2e-user`).
 *
 * ## Secret-handling invariants
 *
 *  - The admin JWT (`zitadel-machine-key-for-pulumi-admin`) is read via
 *    `BackendMachineKeyComponent` and re-exposed as `adminJwt` so SMTP,
 *    ActionsV2, and HumanAdmin dynamic-resource API calls can re-use the
 *    same `pulumi.secret()`-wrapped value. Without the wrap, the embedded
 *    RSA private key would surface in `pulumi preview` output and Pulumi
 *    service state history.
 *  - `loginClientToken` is exposed as `pulumi.Output<string>`. Callers
 *    (here, `src/index.ts`) wrap it in `pulumi.secret()` before passing
 *    it into Gcp's `esoOnlySecrets` so the PAT does not leak in state.
 */
export class ZitadelProdStackComponent extends pulumi.ComponentResource {
	public readonly backendMachineKey: BackendMachineKeyComponent
	public readonly adminOrg: zitadel.Org
	public readonly project: zitadel.Project
	public readonly frontend: FrontendComponent
	public readonly smtp: SmtpComponent
	public readonly actionsV2: ActionsV2Component
	public readonly loginClient: LoginClientComponent
	public readonly googleAdminIdp: GoogleAdminIdpComponent
	public readonly adminOrgConfig: AdminOrgConfigComponent
	public readonly humanAdmin: HumanAdminComponent

	/** PAT for the `login-client` Zitadel MachineUser. Routed via
	 *  `src/index.ts` into Gcp's `esoOnlySecrets` so a GSM Secret named
	 *  `zitadel-login-pat` is created (matches the dev path's wiring). */
	public readonly loginClientToken: pulumi.Output<string>

	/** JWT-profile JSON for the `backend-app` Zitadel MachineUser.
	 *  Exposed for symmetry with the dev `Zitadel` class. Not currently
	 *  routed into Gcp for prod — the inner `BackendMachineKeyComponent`
	 *  already creates the `zitadel-machine-key-for-backend-app` GSM
	 *  Secret + Version + IAM binding directly (the prod path baked in
	 *  by `enable-zitadel-prod-pulumi-provider`). */
	public readonly machineKeyDetails: pulumi.Output<string>

	constructor(
		name: string,
		args: ZitadelProdStackComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:ZitadelProdStack', name, {}, opts)

		const {
			env,
			gcpProject,
			postmarkServerApiToken,
			googleAdminIdpClientId,
			googleAdminIdpClientSecret,
			pannpersGoogleSub,
		} = args

		if (env !== 'prod') {
			// Mirrors the env guard on the dev `Zitadel` class. Staging
			// adoption (if ever required) needs its own bootstrap-uploaded
			// admin JWT + Google OAuth client + ESC wiring; a separate
			// wrapper class is the cleanest path then.
			throw new Error(
				`ZitadelProdStackComponent is prod-only; got env=${env}. ` +
					'Use the dev `Zitadel` class for dev, or create a ' +
					'staging-specific wrapper if staging is ever needed.',
			)
		}

		const domain = zitadelDomainMap[env]
		const consoleUrl = pulumi.interpolate`https://${domain}/ui/console`

		// 1. BackendMachineKeyComponent — provider + productOrg + backend
		// MachineUser + GSM `zitadel-machine-key-for-backend-app`. Reparented
		// under this ComponentResource so the prod block in `src/index.ts`
		// is a single dispatch line. The `parent` change re-anchors the
		// existing prod state under our new URN; `aliases` preserves
		// stateful resources (the backend MachineKey JWT must NOT be
		// re-minted — re-mint cascades the §13.15 `Errors.AuthNKey.NotFound`
		// auth failure).
		this.backendMachineKey = new BackendMachineKeyComponent(
			'backend-app-prod',
			{ env, gcpProject },
			{
				parent: this,
				// Previously a top-level resource (no explicit parent → root
				// stack). `{ parent: pulumi.rootStackResource }` is the
				// canonical "previously had no parent" alias form per the
				// Pulumi SDK comment on `Alias.parent`. Aliases on a parent
				// propagate to child URNs automatically (the child URN's
				// parent-chain segment changes alongside this one), so the
				// inner `MachineUser` + GSM `zitadel-machine-key-for-backend-
				// app` resources keep their state without a destroy-replace
				// cycle (re-mint would cascade the §13.15
				// `Errors.AuthNKey.NotFound` auth failure).
				aliases: [{ parent: pulumi.rootStackResource }],
			},
		)

		const provider = this.backendMachineKey.provider
		const productOrg = this.backendMachineKey.productOrg
		const adminJwt = this.backendMachineKey.adminJwt

		// 2. Admin org — bootstrap-created by Zitadel (configmap sets
		// `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin`). Brought into Pulumi state
		// via one-time `pulumi import zitadel:index/org:Org admin
		// <prod-admin-org-id>` BEFORE the first `pulumi up --stack prod`
		// after this change merges. `protect: true` is mandatory: `pulumi
		// destroy` against the admin org would lock all operators out
		// because the `pulumi-admin` MachineUser the provider authenticates
		// as lives inside it. Mirrors the dev path exactly.
		this.adminOrg = new zitadel.Org(
			'admin',
			{ name: 'admin', isDefault: true },
			{ provider, protect: true, parent: this },
		)

		// 3. Product Project — hosts the frontend `ApplicationOidc` below.
		// Mirrors dev's `Zitadel.project` constructor args verbatim.
		this.project = new zitadel.Project(
			name,
			{
				name,
				orgId: productOrg.id,
				projectRoleAssertion: false,
				projectRoleCheck: false,
				hasProjectCheck: false,
				privateLabelingSetting: 'PRIVATE_LABELING_SETTING_UNSPECIFIED',
			},
			{ provider, parent: this, dependsOn: [productOrg] },
		)

		// 4. Frontend SPA — `ApplicationOidc` + product-org `LoginPolicy`
		// (passkey + username/password, `userLogin=true`, `allowRegister=true`).
		this.frontend = new FrontendComponent(
			name,
			{
				env,
				orgId: productOrg.id,
				projectId: this.project.id,
				provider,
			},
			{ parent: this },
		)

		// 5. Postmark SMTP + dynamic `_activate` call. The activation is
		// required for prod sign-up verification emails — Zitadel v4
		// SmtpConfig provisioning alone does NOT activate the config; a
		// separate admin API call is needed (per cutover §13.16 incident).
		this.smtp = new SmtpComponent(
			name,
			{
				env,
				serverApiToken: postmarkServerApiToken,
				provider,
				domain,
				jwtProfileJson: adminJwt,
			},
			{ parent: this },
		)

		// 6. Actions V2 — REST webhook to backend's `/pre-access-token`
		// endpoint, fires on the `preaccesstoken` flow to inject the
		// `email` claim into JWT access tokens before issuance. Without
		// this, backend's `ValidateIdentity` fails closed (the `email`
		// claim is required across all backend code paths).
		this.actionsV2 = new ActionsV2Component(
			name,
			{
				domain,
				jwtProfileJson: adminJwt,
				preAccessTokenEndpoint: `${BACKEND_WEBHOOK_BASE_URL}${PRE_ACCESS_TOKEN_PATH}`,
				provider,
			},
			{ parent: this },
		)

		// 7. Login V2 UI service identity — admin-org `MachineUser` +
		// instance `IAM_LOGIN_CLIENT` role + `PersonalAccessToken`. Lives
		// in the admin org per the "Place Machine Users by Responsibility"
		// rule (operator-tier identities go in admin, end-user-tier in
		// product). The PAT surfaces via `loginClientToken` below.
		this.loginClient = new LoginClientComponent(
			name,
			{ orgId: this.adminOrg.id, provider },
			{ parent: this },
		)

		// 8. Instance-level Google IdP for operator (Admin Console) sign-in.
		// Keyed on a SEPARATE prod Google OAuth Web Application client
		// (created out-of-band in Google Cloud Console); not the dev
		// client. The admin-org LoginPolicy below references this IdP's id.
		this.googleAdminIdp = new GoogleAdminIdpComponent(
			name,
			{
				clientId: googleAdminIdpClientId,
				clientSecret: googleAdminIdpClientSecret,
				provider,
			},
			{ parent: this },
		)

		// 9. Login policies — admin-org explicit override + instance
		// `DefaultLoginPolicy` mirror. Both reference the Google IdP so
		// Console login surfaces the Google button regardless of which
		// routing path Login V2 takes (instance default vs. user's home
		// org — design D8). `userLogin=false` + `allowRegister=false`
		// confine Console sign-in to the Google IdP path.
		this.adminOrgConfig = new AdminOrgConfigComponent(
			name,
			{
				adminOrgId: this.adminOrg.id,
				googleIdpId: this.googleAdminIdp.idp.id,
				provider,
				consoleUrl,
			},
			{ parent: this },
		)

		// 10. Human admin (pannpers@pannpers.dev) in the admin org. The
		// Google identity is pre-linked via `ZitadelUserIdpLink` (inside
		// the component) — required because the admin org's policy
		// disables auto-create + userLogin, so the very first Console
		// sign-in needs a pre-existing `(idpId, externalUserId)` link
		// to resolve to the local IAM_OWNER user.
		this.humanAdmin = new HumanAdminComponent(
			name,
			{
				adminOrgId: this.adminOrg.id,
				email: 'pannpers@pannpers.dev',
				firstName: 'Kyosuke',
				lastName: 'Hamada',
				googleIdpId: this.googleAdminIdp.idp.id,
				googleSub: pannpersGoogleSub,
				domain,
				jwtProfileJson: adminJwt,
				provider,
			},
			{ parent: this },
		)

		this.loginClientToken = this.loginClient.token
		this.machineKeyDetails = this.backendMachineKey.keyDetails

		this.registerOutputs({
			backendMachineKey: this.backendMachineKey,
			adminOrg: this.adminOrg,
			project: this.project,
			frontend: this.frontend,
			smtp: this.smtp,
			actionsV2: this.actionsV2,
			loginClient: this.loginClient,
			googleAdminIdp: this.googleAdminIdp,
			adminOrgConfig: this.adminOrgConfig,
			humanAdmin: this.humanAdmin,
			loginClientToken: this.loginClientToken,
			machineKeyDetails: this.machineKeyDetails,
		})
	}
}
