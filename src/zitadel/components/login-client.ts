import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'

export interface LoginClientComponentArgs {
	/** Org to host the machine user. The role granted below is instance-wide,
	 *  so org choice is purely organizational. We use the same org as the
	 *  application machine users to keep service identities co-located. */
	orgId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * LoginClientComponent provisions a Zitadel Machine User with a Personal
 * Access Token (PAT) for the self-hosted `zitadel-login` (Login V2 UI
 * Next.js) container to authenticate against the Zitadel API.
 *
 * Required by Zitadel for self-hosted Login V2 — the Login UI must call
 * privileged settings + cross-org user-search APIs at SSR time, which a
 * regular OIDC end-user token cannot do. See:
 *   https://zitadel.com/docs/self-hosting/manage/login-client
 *
 * Permissions: `IAM_LOGIN_CLIENT` granted at instance level (not org).
 *   - Limited but elevated: instance settings read, cross-org user
 *     lookups, session creation, password / IDP intent verification.
 *   - Strictly less than `IAM_OWNER` (which the bootstrap admin SA holds).
 *
 * Authentication: Personal Access Token with **no expirationDate** (dev
 * only). Rationale:
 *   - Zitadel's PAT is the upstream-supported auth method for the Login
 *     V2 container. JWT-key auth is not implemented in `zitadel-login`.
 *   - Setting an expiration on dev would create a "silent breakage on day
 *     N" failure mode that's strictly worse than no expiration here. The
 *     dev blast radius (no real user data) makes long-lived OK.
 *   - Production must set `expirationDate` and implement rotation —
 *     either via Cloud Monitoring alert + manual runbook, or via a
 *     CronJob that mints + revokes PATs. Not implemented here; tracked
 *     separately when self-hosted Zitadel extends to staging / prod.
 *
 * The PAT value is exposed as `token: pulumi.Output<string>`. Callers
 * MUST wrap further uses in `pulumi.secret()` and store it in GCP Secret
 * Manager — never log or expose directly.
 */
export class LoginClientComponent extends pulumi.ComponentResource {
	public readonly machineUser: zitadel.MachineUser
	public readonly instanceMember: zitadel.InstanceMember
	public readonly pat: zitadel.PersonalAccessToken

	/** Personal Access Token value. Bearer-prefix it as
	 *  `Authorization: Bearer ${token}` when calling Zitadel APIs. */
	public readonly token: pulumi.Output<string>

	constructor(
		name: string,
		args: LoginClientComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:LoginClient', name, {}, opts)

		const { orgId, provider } = args
		const resourceOptions = { provider, parent: this }

		this.machineUser = new zitadel.MachineUser(
			'login-client',
			{
				orgId,
				userName: 'login-client',
				name: 'Zitadel Login V2 Client',
				description:
					'Service user for the self-hosted zitadel-login (Login V2 UI) ' +
					'container. Authenticated via PAT, granted IAM_LOGIN_CLIENT at ' +
					'instance level. Required per Zitadel self-hosted login docs.',
				// PAT is always opaque regardless of this setting; using BEARER for
				// clarity — JWT mode here would only affect OAuth2 token requests
				// which the login UI does not perform with this user.
				accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
			},
			resourceOptions,
		)

		// Grant IAM_LOGIN_CLIENT at instance level. This is the role specifically
		// designed for the Login UI's permission needs (cross-org user search,
		// settings read, session management). It is strictly less powerful than
		// IAM_OWNER (held by the bootstrap admin SA used by Pulumi).
		this.instanceMember = new zitadel.InstanceMember(
			'login-client-member',
			{
				userId: this.machineUser.id,
				roles: ['IAM_LOGIN_CLIENT'],
			},
			{ ...resourceOptions, dependsOn: [this.machineUser] },
		)

		// PAT with no expirationDate — see component docstring for rationale.
		// Depend on the InstanceMember so the role is granted before the token
		// is minted (otherwise the first API call from zitadel-login could race
		// the role propagation and 403).
		this.pat = new zitadel.PersonalAccessToken(
			'login-client-pat',
			{
				orgId,
				userId: this.machineUser.id,
			},
			{ ...resourceOptions, dependsOn: [this.instanceMember] },
		)

		this.token = this.pat.token

		this.registerOutputs({
			machineUser: this.machineUser,
			instanceMember: this.instanceMember,
			pat: this.pat,
			token: this.token,
		})
	}
}
