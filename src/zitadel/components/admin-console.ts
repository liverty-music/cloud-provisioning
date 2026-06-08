import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import { baseDomainMap } from '../constants.js'

/**
 * Project role key for admin-console access. The backend's RBAC gate
 * (`auth.RequireRole(ctx, "admin")`) checks for exactly this role name in the
 * token's `urn:zitadel:iam:org:project:roles` claim, so the two MUST stay in
 * sync — changing this value requires a matching backend change.
 */
export const ADMIN_CONSOLE_ROLE_ADMIN = 'admin'

export interface AdminConsoleComponentArgs {
	env: Environment
	/** ID of the bootstrap-created `admin` role org. The admin console app
	 *  lives here so that the admin org's Google-Workspace LoginPolicy
	 *  (provisioned by `AdminOrgConfigComponent`) is the access boundary. */
	adminOrgId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * AdminConsoleComponent provisions the internal admin console's OIDC
 * surface in the `admin` role org — a sibling of the consumer
 * `FrontendComponent` (which lives in the product org), not a
 * modification of it.
 *
 * ## Why the admin org (authN as the access boundary)
 *
 * The admin console authenticates against the **`admin` org**, reusing
 * `oidc-client-ts` PKCE exactly like the consumer SPA, but the SPA passes
 * the admin org id in the `urn:zitadel:iam:org:id:<id>` scope so Zitadel
 * applies the admin org's Google-Workspace login policy
 * (`AdminOrgConfigComponent.adminLoginPolicy`). Because only Google
 * Workspace accounts can complete that flow, authentication itself is the
 * access boundary — no separate authorization layer is needed for the
 * foundation. This component therefore provisions ONLY the project + app;
 * it must NOT declare a LoginPolicy/LabelPolicy (the admin org already
 * owns those). See OpenSpec change `add-admin-console`, design D1.
 *
 * ## Project
 *
 * Zitadel apps belong to a project, and the admin org has no existing
 * project (the consumer `liverty-music` Project lives in the product
 * org). A minimal `admin-console` project is created here to host the
 * app. Role assertion/checks are left off — the foundation has no admin
 * roles yet (deferred to a follow-up change).
 */
export class AdminConsoleComponent extends pulumi.ComponentResource {
	public readonly project: zitadel.Project
	public readonly application: zitadel.ApplicationOidc
	public readonly adminRole: zitadel.ProjectRole

	constructor(
		name: string,
		args: AdminConsoleComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:AdminConsole', name, {}, opts)

		const { env, adminOrgId, provider } = args
		const resourceOptions = { provider, parent: this }

		// The admin console is served at `admin.{base-domain}` per
		// environment (dev: admin.dev.liverty-music.app, prod:
		// admin.liverty-music.app).
		const domain = `admin.${baseDomainMap[env]}`

		// Ternary spread (per `refactor-unify-env-dispatch`): localhost URIs
		// are only meaningful when env === 'dev'. Other envs receive the
		// public admin host only. Mirrors `FrontendComponent`.
		const redirectUris = [
			`https://${domain}/auth/callback`,
			...(env === 'dev' ? ['http://localhost:9000/auth/callback'] : []),
		]
		const postLogoutRedirectUris = [
			`https://${domain}/`,
			...(env === 'dev' ? ['http://localhost:9000/'] : []),
		]

		// Minimal project to host the admin console app inside the admin org.
		// projectRoleAssertion governs the userinfo/ID-token role paths; the
		// access-token roles that the backend gate actually reads are turned on
		// by `accessTokenRoleAssertion` on the app below. Both are enabled so the
		// `admin` role surfaces wherever it is consumed. projectRoleCheck stays
		// OFF so sign-in is not blocked on a grant — authorization is enforced at
		// the backend, keeping the login flow resilient.
		this.project = new zitadel.Project(
			'admin-console',
			{
				name: 'admin-console',
				orgId: adminOrgId,
				projectRoleAssertion: true,
				projectRoleCheck: false,
				hasProjectCheck: false,
			},
			resourceOptions,
		)

		// Admin console OIDC app — mirrors the consumer `web-frontend`
		// ApplicationOidc settings (public SPA, PKCE, no secret), scoped to
		// the admin org with admin-host redirect URIs.
		this.application = new zitadel.ApplicationOidc(
			'admin-console',
			{
				projectId: this.project.id,
				name: 'admin-console',
				orgId: adminOrgId,
				// JWT access token to keep stateless validation parity with the
				// consumer app if a future admin backend needs it.
				accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
				// SPA running in the browser.
				appType: 'OIDC_APP_TYPE_USER_AGENT',
				// PKCE public client — no client secret.
				authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
				grantTypes: [
					'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
					'OIDC_GRANT_TYPE_REFRESH_TOKEN',
				],
				responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
				// Embed the project roles into the JWT *access* token. This is the
				// flag the backend depends on: it validates the bearer access token
				// and reads `urn:zitadel:iam:org:project:roles` via
				// `auth.RequireRole(ctx, "admin")`. Project-level
				// `projectRoleAssertion` only governs userinfo/ID-token paths, so
				// without this the bearer token carries no roles and every
				// ConcertModerationService RPC is denied for the granted admin.
				accessTokenRoleAssertion: true,
				// Assert roles/userinfo in the ID token too, so a client-side admin
				// guard can read them without an extra round-trip.
				idTokenRoleAssertion: true,
				idTokenUserinfoAssertion: true,
				clockSkew: '0s',
				redirectUris,
				postLogoutRedirectUris,
				// Allow http://localhost for development.
				devMode: env === 'dev',
			},
			resourceOptions,
		)

		// The single `admin` role on the admin-console project. Granted to the
		// human admin(s) via a UserGrant in the parent stack; the backend's
		// ConcertModerationService requires this role on every RPC.
		this.adminRole = new zitadel.ProjectRole(
			'admin-console-admin',
			{
				orgId: adminOrgId,
				projectId: this.project.id,
				roleKey: ADMIN_CONSOLE_ROLE_ADMIN,
				displayName: 'Admin',
			},
			resourceOptions,
		)

		this.registerOutputs({
			project: this.project,
			application: this.application,
			adminRole: this.adminRole,
		})
	}
}
