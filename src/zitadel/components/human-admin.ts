import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'
import * as zitadel from '@pulumiverse/zitadel'
import { ZitadelUserIdpLink } from '../dynamic/user-idp-link.js'

export interface HumanAdminComponentArgs {
	/** ID of the bootstrap-created `admin` role org. */
	adminOrgId: pulumi.Input<string>
	/** Admin's verified email address (also used as the local userName so
	 *  that the Login V2 username field accepts the email directly). */
	email: pulumi.Input<string>
	/** Admin's first name (Workspace profile). */
	firstName: pulumi.Input<string>
	/** Admin's last name (Workspace profile). */
	lastName: pulumi.Input<string>
	/** Instance-level Google IdP id to pre-link to this human user. */
	googleIdpId: pulumi.Input<string>
	/**
	 * Google `sub` claim for this admin's Google account. Must be the
	 * stable numeric subject identifier returned by Google OIDC, not the
	 * email — the email can change while the sub never does. Provisioned
	 * via ESC `pulumiConfig.zitadel.adminGoogleSubs.<userName>`.
	 */
	googleSub: pulumi.Input<string>
	/** Zitadel domain (for the Dynamic Resource API call). */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON (for the Dynamic Resource API call). */
	jwtProfileJson: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * HumanAdminComponent provisions a single human admin user in the
 * `admin` role org and grants them `IAM_OWNER` at the instance level.
 *
 * Sign-in flow: the admin signs in via Google IdP. The IdP identity is
 * pre-linked at provisioning time by `ZitadelUserIdpLink` below using
 * the admin's Google `sub` claim, so the very first sign-in resolves
 * straight to the local user. The local user's `IAM_OWNER` membership
 * then applies — the admin can use the Console.
 *
 * ## Why pre-link the Google identity in Pulumi
 *
 * The admin org's `LoginPolicy` disables username/password
 * (`userLogin = false`) and the Google IdP forbids auto-creation
 * (`isCreationAllowed = false`). With both off, Login V2 has no native
 * way to bootstrap the first sign-in: there is no password to
 * authenticate the autoLink prompt, and no permission to mint a fresh
 * user from the OIDC profile. Without a pre-existing
 * `(idpId, externalUserId)` record, the IdP callback dead-ends on the
 * `account-not-found` page.
 *
 * `ZitadelUserIdpLink` declares that record up front, breaking the
 * deadlock declaratively in IaC. See `dynamic/user-idp-link.ts` for the
 * full rationale.
 *
 * ## Adding a new admin
 *
 * The end-to-end procedure (Google `sub` lookup → ESC config → Pulumi
 * code → verification) is captured in
 * `docs/runbooks/add-zitadel-admin-user.md`. Follow it instead of
 * copy-pasting this component blind — there are operational steps
 * (ESC entry, sub-claim capture, post-deploy smoke test) that aren't
 * visible from the code alone.
 *
 * ## Why a random initialPassword
 *
 * `@pulumiverse/zitadel.HumanUser` documents:
 *
 *   > Caution: Email can only be set verified if a password is set for
 *   > the user, either with initialPassword or during runtime.
 *
 * We need `isEmailVerified = true` at creation so the OIDC sign-in
 * flow does not block on an OTP step (the existing pattern documented
 * in the identity-management capability for self-registration). The
 * provider only allows that if `initialPassword` is also present.
 *
 * Setting a random, never-disclosed password satisfies the constraint.
 * The password is unreachable in practice because the admin org's
 * `LoginPolicy.userLogin = false` (see `AdminOrgConfigComponent`)
 * disables the username + password sign-in form entirely. The Login V2
 * UI for the admin org only ever presents the IdP buttons.
 *
 * `random.RandomPassword` persists the value in Pulumi state, but it
 * never leaves Pulumi (no Output, no GSM write, no log). This is a
 * deliberate trade-off: the password's existence is needed only to
 * unlock `isEmailVerified`, not to be used.
 */
export class HumanAdminComponent extends pulumi.ComponentResource {
	public readonly humanUser: zitadel.HumanUser
	public readonly instanceMember: zitadel.InstanceMember
	public readonly googleIdpLink: ZitadelUserIdpLink

	constructor(
		name: string,
		args: HumanAdminComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:HumanAdmin', name, {}, opts)

		const {
			adminOrgId,
			email,
			firstName,
			lastName,
			googleIdpId,
			googleSub,
			domain,
			jwtProfileJson,
			provider,
		} = args
		const resourceOptions = { provider, parent: this }

		// Random password to satisfy @pulumiverse/zitadel's constraint that
		// isEmailVerified=true requires a password to be present. Never
		// exposed beyond Pulumi state. Length 64; `special: true` and
		// `minSpecial: 4` are required because Zitadel's default password
		// complexity policy rejects passwords without symbols (`Password
		// must contain symbol (COMMA-ZDLwA)`). The password is never used
		// (admin org `LoginPolicy.userLogin = false`), so shell-safety
		// concerns from inspecting state manually do not apply.
		const password = new random.RandomPassword(
			'admin-initial-password',
			{
				length: 64,
				special: true,
				minSpecial: 4,
				upper: true,
				lower: true,
				numeric: true,
				minUpper: 4,
				minLower: 4,
				minNumeric: 4,
			},
			{ parent: this },
		)

		this.humanUser = new zitadel.HumanUser(
			'pannpers',
			{
				orgId: adminOrgId,
				// userName + email are the same so Login V2's username field
				// accepts the email address directly. preferredLoginName ends
				// up being the email after Zitadel applies the username rules.
				userName: email,
				email,
				firstName,
				lastName,
				preferredLanguage: 'ja',
				// Pre-verified email, paired with the random initialPassword
				// above per the @pulumiverse/zitadel constraint.
				isEmailVerified: true,
				initialPassword: pulumi.secret(password.result),
			},
			resourceOptions,
		)

		// Grant IAM_OWNER at instance level so this admin can perform any
		// Console / Management API operation across all orgs in the instance.
		this.instanceMember = new zitadel.InstanceMember(
			'pannpers-iam-owner',
			{
				userId: this.humanUser.id,
				roles: ['IAM_OWNER'],
			},
			{ ...resourceOptions, dependsOn: [this.humanUser] },
		)

		// Pre-link the Google identity to this local user so the very first
		// `/ui/console` Google sign-in lands directly on the local
		// IAM_OWNER. Required because the admin org's userLogin/auto-create
		// settings leave no native first-link path — see header comment and
		// `dynamic/user-idp-link.ts`.
		this.googleIdpLink = new ZitadelUserIdpLink(
			'pannpers-google-link',
			{
				domain,
				jwtProfileJson,
				userId: this.humanUser.id,
				idpId: googleIdpId,
				externalUserId: googleSub,
				displayName: email,
			},
			{ parent: this, dependsOn: [this.humanUser] },
		)

		this.registerOutputs({
			humanUser: this.humanUser,
			instanceMember: this.instanceMember,
			googleIdpLink: this.googleIdpLink,
		})
	}
}
