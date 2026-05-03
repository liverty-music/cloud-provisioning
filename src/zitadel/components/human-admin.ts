import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'
import * as zitadel from '@pulumiverse/zitadel'

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
	provider: zitadel.Provider
}

/**
 * HumanAdminComponent provisions a single human admin user in the
 * `admin` role org and grants them `IAM_OWNER` at the instance level.
 *
 * Sign-in flow: the admin signs in via Google IdP. Zitadel matches the
 * verified Google email to the local user provisioned here and links
 * the IdP identity (see `GoogleAdminIdpComponent` for the linking
 * settings). After the link is established, the local user's
 * `IAM_OWNER` membership applies — the admin can use the Console.
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

	constructor(
		name: string,
		args: HumanAdminComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:HumanAdmin', name, {}, opts)

		const { adminOrgId, email, firstName, lastName, provider } = args
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

		this.registerOutputs({
			humanUser: this.humanUser,
			instanceMember: this.instanceMember,
		})
	}
}
