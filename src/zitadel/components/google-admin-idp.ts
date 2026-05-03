import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'

export interface GoogleAdminIdpComponentArgs {
	/** OAuth 2.0 Web Application client_id from the Google Cloud project
	 *  hosting the consent screen for `pannpers.dev` Workspace admins. */
	clientId: pulumi.Input<string>
	/** OAuth 2.0 Web Application client_secret. MUST be passed as a
	 *  `pulumi.Output<string>` wrapped in `pulumi.secret()` upstream so it
	 *  is masked in state and previews. */
	clientSecret: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * GoogleAdminIdpComponent provisions the instance-level Google IdP that
 * the `admin` role org's `LoginPolicy` references for human admin
 * sign-in to the Zitadel Admin Console.
 *
 * Identity flow on first sign-in:
 *   1. Pannpers visits `/ui/console`.
 *   2. Login V2 shows the IdP buttons listed in the admin org's policy.
 *   3. Pannpers clicks "Sign in with Google", completes Google OAuth.
 *   4. Zitadel receives the verified email `pannpers@pannpers.dev`.
 *   5. Because `isLinkingAllowed = true` and a local `HumanUser` with
 *      that email already exists in the admin org (provisioned by
 *      `HumanAdminComponent`), Zitadel links the IdP identity to the
 *      local user without creating a duplicate.
 *   6. The local user holds `IAM_OWNER` via `InstanceMember`, so Console
 *      loads with full instance-level access.
 *
 * Why instance-level (not org-level): the admin org's `LoginPolicy`
 * references this IdP via the instance-level id. Org-level IdPs would
 * couple the IdP lifecycle to one org and make it harder to reuse for a
 * future second admin org or for other instance-level IdPs.
 *
 * Why `isCreationAllowed = false` and `isAutoCreation = false`: only
 * pre-provisioned local human users (declared in Pulumi) may receive
 * `IAM_OWNER`. Allowing auto-creation would let anyone with a
 * pannpers.dev Google account become a Zitadel user implicitly.
 *
 * Why `isAutoUpdate = true`: keep first/last name and email fresh on
 * each sign-in, so display names in audit logs match Workspace.
 */
export class GoogleAdminIdpComponent extends pulumi.ComponentResource {
	public readonly idp: zitadel.IdpGoogle

	constructor(
		name: string,
		args: GoogleAdminIdpComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:GoogleAdminIdp', name, {}, opts)

		const { clientId, clientSecret, provider } = args
		const resourceOptions = { provider, parent: this }

		this.idp = new zitadel.IdpGoogle(
			'admin-google',
			{
				name: 'Google (admin)',
				clientId,
				clientSecret,
				scopes: ['openid', 'profile', 'email'],
				// Allow linking incoming Google identity to a pre-provisioned
				// local human user with matching verified email. This is the
				// auto-link mechanism for the admin Console sign-in flow.
				isLinkingAllowed: true,
				// Disallow auto-create of new local users from external sign-in.
				// Only Pulumi-declared HumanUsers may receive IAM_OWNER.
				isCreationAllowed: false,
				isAutoCreation: false,
				// Keep first/last name + email fresh on each sign-in so audit
				// logs show the current Workspace display name.
				isAutoUpdate: true,
			},
			resourceOptions,
		)

		this.registerOutputs({ idp: this.idp })
	}
}
