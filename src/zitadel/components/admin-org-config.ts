import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'

export interface AdminOrgConfigComponentArgs {
	/** ID of the bootstrap-created `admin` role org. */
	adminOrgId: pulumi.Input<string>
	/** ID of the instance-level Google IdP that admins sign in with. */
	googleIdpId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * AdminOrgConfigComponent provisions login-policy resources that govern
 * how human admins authenticate to the Zitadel Admin Console:
 *
 * 1. `LoginPolicy` on the `admin` org — explicit override that disables
 *    username + password sign-in (`userLogin = false`) and exposes the
 *    Google IdP as the only sign-in method.
 *
 * 2. `DefaultLoginPolicy` (instance-level) — mirror of the admin org's
 *    policy. Acts as the fallback Login V2 uses when an OIDC AuthN
 *    arrives without a specific org context (e.g., Console login). The
 *    `liverty-music` product org has its own explicit `LoginPolicy`
 *    override (passkey-only) that takes precedence over this default for
 *    end-user app sign-in.
 *
 * Why both: Login V2's exact routing rule between "instance default" and
 * "user's home org" is under-documented in Zitadel v4. Configuring both
 * layers identically converges on the same correct outcome regardless of
 * which path Zitadel takes (see OpenSpec design D8).
 *
 * `allowDomainDiscovery = true` is set on the admin org policy so that
 * future explicit verified-domain registration (e.g. `pannpers.dev` as a
 * verified org domain) just works for email-domain routing.
 *
 * `userLogin = false` is the linchpin that makes the random
 * `initialPassword` we set on the human admin (required to unlock
 * `isEmailVerified = true` at creation per @pulumiverse/zitadel) totally
 * unreachable for sign-in.
 */
export class AdminOrgConfigComponent extends pulumi.ComponentResource {
	public readonly adminLoginPolicy: zitadel.LoginPolicy
	public readonly defaultLoginPolicy: zitadel.DefaultLoginPolicy

	constructor(
		name: string,
		args: AdminOrgConfigComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:AdminOrgConfig', name, {}, opts)

		const { adminOrgId, googleIdpId, provider } = args
		const resourceOptions = { provider, parent: this }

		// Shared policy fields. Most lifetimes are the same as the existing
		// product-org LoginPolicy in `frontend.ts` for consistency. NOT
		// declared with `as const` because @pulumiverse/zitadel's
		// `idps?: pulumi.Input<pulumi.Input<string>[]>` requires a mutable
		// array — a readonly tuple would not assign.
		const sharedPolicyFields = {
			// Disable username + password sign-in. The random initialPassword
			// on the human admin (required so isEmailVerified can be true at
			// creation) is unreachable because of this flag.
			userLogin: false,
			// Disallow self-registration. Only Pulumi-provisioned HumanUsers
			// may exist in this org; auto-register would let any Google
			// identity become a Zitadel user.
			allowRegister: false,
			// Permit the IdP buttons to appear on the Login UI.
			allowExternalIdp: true,
			// Multi-factor controls — not enforced; passkey or Google's own
			// MFA covers the strong-auth side. Revisit when adding more
			// admins or when prod follows.
			forceMfa: false,
			forceMfaLocalOnly: false,
			// Passkey allowed as a separate flow alongside Google IdP for
			// future flexibility (e.g. an admin enrolls a passkey directly).
			passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
			// Hide password reset link — there is no usable password to reset.
			hidePasswordReset: true,
			// User convenience: do not 404 on unknown usernames at the first
			// step (mirrors product-org policy).
			ignoreUnknownUsernames: true,
			// Default redirect after a context-less login completes. Send to
			// the Console UI so admins land somewhere meaningful.
			defaultRedirectUri: 'https://auth.dev.liverty-music.app/ui/console',
			// Standard session lifetimes (mirrored from product org policy).
			passwordCheckLifetime: '240h0m0s',
			externalLoginCheckLifetime: '240h0m0s',
			multiFactorCheckLifetime: '24h0m0s',
			mfaInitSkipLifetime: '720h0m0s',
			secondFactorCheckLifetime: '24h0m0s',
			// IdP buttons to display.
			idps: [googleIdpId],
		}

		// Admin org explicit LoginPolicy override.
		this.adminLoginPolicy = new zitadel.LoginPolicy(
			'admin-org-login-policy',
			{
				...sharedPolicyFields,
				orgId: adminOrgId,
				// Future-proof email-domain routing. Does not require a
				// verified domain to be registered today.
				allowDomainDiscovery: true,
			},
			resourceOptions,
		)

		// Instance-level DefaultLoginPolicy. Used as fallback when no org
		// override applies (notably Console login per design D8).
		this.defaultLoginPolicy = new zitadel.DefaultLoginPolicy(
			'instance-default-login-policy',
			{
				...sharedPolicyFields,
				allowDomainDiscovery: true,
			},
			resourceOptions,
		)

		this.registerOutputs({
			adminLoginPolicy: this.adminLoginPolicy,
			defaultLoginPolicy: this.defaultLoginPolicy,
		})
	}
}
