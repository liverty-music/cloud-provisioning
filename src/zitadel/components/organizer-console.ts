import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import { baseDomainMap } from '../constants.js'

/**
 * Project role key for the Organizer console: the tenant **owner** — the
 * principal operator of one Organizer. An operator granted this role on a
 * Project-Granted Organizer tenant org carries `owner` in the token's
 * `urn:zitadel:iam:org:project:roles` claim; the organizer API server's authz
 * gate reads exactly this string, so the two MUST stay in sync — changing this
 * value requires a matching backend change. Only `owner` is defined now; the
 * sub-owner roles (`editor`, `viewer`, `reception`) are a later change.
 *
 * Named `owner`, NOT `admin`: `admin` already denotes the Liverty-internal
 * operator role on the separate `admin-console` project
 * (`ADMIN_CONSOLE_ROLE_ADMIN`), so reusing it would overload the roles claim
 * and collide with Zitadel's own admin concepts. This principal is the
 * tenant's owner, not a platform administrator — `owner` is the accurate,
 * industry-standard term (cf. Zitadel `ORG_OWNER`).
 */
export const ORGANIZER_CONSOLE_ROLE_OWNER = 'owner'

export interface OrganizerConsoleComponentArgs {
	env: Environment
	/**
	 * ID of the `liverty-music` product org. The `organizer-console` project
	 * (its role + apps) is owned here — the console is a Liverty-Music product
	 * surface — and is Project-Granted to each Organizer tenant org at runtime
	 * (the grant itself is NOT created by IaC). The owner org is only the
	 * project's administrative home; operators authenticate in their own tenant
	 * org, so this org's login policy never applies to them.
	 */
	productOrgId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * OrganizerConsoleComponent provisions the static Zitadel scaffolding for the
 * Organizer B2B tenancy model: a single, actor-named `organizer-console`
 * Project in the product org that every Organizer tenant shares via Project
 * Grant, plus the OIDC client the console SPA uses and the `backend-api` app
 * that names the audience the organizer API server validates.
 *
 * ## Why actor-named, shared, and in the product org
 *
 * - **Actor-named (`organizer-console`, not generic `console`)** so a future
 *   `venue-console` never collides — RBAC (roles/grants) is project-scoped, so
 *   a distinct actor gets a distinct project.
 * - **Shared, single OIDC app** — one client serves operators of any Organizer
 *   tenant org; per-tenant isolation comes from the tenant org + Project Grant,
 *   not from a per-tenant app.
 * - **Owned by the product org** (not the internal-only `admin` org nor a new
 *   `platform` org) because the organizer console is an external-facing product
 *   surface; a *separate* project (not the fan `liverty-music` project) keeps
 *   its roles/grants/branding independent. See `docs/zitadel-tenancy-model.md`.
 *
 * This component provisions ONLY the project + role + apps. Per-Organizer
 * tenant orgs, their Project Grants, User Grants, and the passkey-only login
 * policy are runtime concerns of the later `organizer-accounts` change.
 */
export class OrganizerConsoleComponent extends pulumi.ComponentResource {
	public readonly project: zitadel.Project
	public readonly ownerRole: zitadel.ProjectRole
	public readonly application: zitadel.ApplicationOidc
	public readonly backendApi: zitadel.ApplicationApi

	constructor(
		name: string,
		args: OrganizerConsoleComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:OrganizerConsole', name, {}, opts)

		const { env, productOrgId, provider } = args
		const resourceOptions = { provider, parent: this }

		// The organizer console is served at `organizer.{base-domain}` per
		// environment (dev: organizer.dev.liverty-music.app, prod:
		// organizer.liverty-music.app), mirroring the admin console's
		// `admin.{base-domain}` convention.
		const domain = `organizer.${baseDomainMap[env]}`

		// Ternary spread (per `refactor-unify-env-dispatch`): localhost URIs are
		// only meaningful when env === 'dev'. Other envs receive the public
		// organizer host only. Mirrors `AdminConsoleComponent`.
		const redirectUris = [
			`https://${domain}/auth/callback`,
			...(env === 'dev' ? ['http://localhost:9100/auth/callback'] : []),
		]
		const postLogoutRedirectUris = [
			`https://${domain}/`,
			...(env === 'dev' ? ['http://localhost:9100/'] : []),
		]

		// The shared organizer-console project in the product org.
		// projectRoleAssertion is ON so the `owner` role surfaces in the
		// userinfo/ID-token paths; the access-token roles the organizer API
		// server actually reads are turned on by `accessTokenRoleAssertion` on
		// the OIDC app below. projectRoleCheck stays OFF so sign-in is not
		// blocked on a missing grant — authorization is enforced at the backend,
		// keeping the login flow resilient (an operator whose grant has not yet
		// been created can still authenticate).
		this.project = new zitadel.Project(
			'organizer-console',
			{
				name: 'organizer-console',
				orgId: productOrgId,
				projectRoleAssertion: true,
				projectRoleCheck: false,
				hasProjectCheck: false,
			},
			resourceOptions,
		)

		// The single `owner` role. Granted to an operator on their Organizer
		// tenant org via a runtime User Grant (in `organizer-accounts`). The
		// sub-owner roles (editor/viewer/reception) are out of scope here.
		this.ownerRole = new zitadel.ProjectRole(
			'organizer-console-owner',
			{
				orgId: productOrgId,
				projectId: this.project.id,
				roleKey: ORGANIZER_CONSOLE_ROLE_OWNER,
				displayName: 'Owner',
			},
			resourceOptions,
		)

		// Organizer console OIDC app — mirrors the admin console / consumer SPA
		// settings (public SPA, PKCE, no secret), a single client serving every
		// Organizer tenant. Redirect URIs carry the organizer host per env.
		this.application = new zitadel.ApplicationOidc(
			'organizer-console',
			{
				projectId: this.project.id,
				name: 'organizer-console',
				orgId: productOrgId,
				accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
				appType: 'OIDC_APP_TYPE_USER_AGENT',
				// PKCE public client — no client secret.
				authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
				grantTypes: [
					'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
					'OIDC_GRANT_TYPE_REFRESH_TOKEN',
				],
				responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
				// Embed the project roles into the JWT *access* token — the claim
				// the organizer API server validates (`urn:zitadel:iam:org:project:
				// roles`). Project-level `projectRoleAssertion` only governs the
				// userinfo/ID-token paths, so without this the bearer token carries
				// no roles.
				accessTokenRoleAssertion: true,
				idTokenRoleAssertion: true,
				idTokenUserinfoAssertion: true,
				clockSkew: '0s',
				redirectUris,
				postLogoutRedirectUris,
				devMode: env === 'dev',
			},
			resourceOptions,
		)

		// Backend API application — names the audience the organizer API server
		// validates. Its project id is requested into the access token by the
		// organizer console (scope `urn:zitadel:iam:org:project:id:<id>:aud`), so
		// the resource server can pin `aud`. BASIC auth method is the lightest
		// choice; the backend validates tokens statelessly against JWKS and does
		// not use this app's credential for introspection, so no secret is
		// exported.
		this.backendApi = new zitadel.ApplicationApi(
			'organizer-backend-api',
			{
				projectId: this.project.id,
				orgId: productOrgId,
				name: 'backend-api',
				authMethodType: 'API_AUTH_METHOD_TYPE_BASIC',
			},
			resourceOptions,
		)

		this.registerOutputs({
			project: this.project,
			ownerRole: this.ownerRole,
			application: this.application,
			backendApi: this.backendApi,
		})
	}
}
