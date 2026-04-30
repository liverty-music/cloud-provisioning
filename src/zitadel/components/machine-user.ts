import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'

export interface MachineUserComponentArgs {
	orgId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * MachineUserComponent provisions a Zitadel Machine User with a Private Key
 * JWT credential for backend-to-Zitadel API communication.
 *
 * The machine user is granted ORG_USER_MANAGER role, which is the minimum
 * permission level required to call user email send/resend APIs.
 *
 * The key details (JWT profile JSON) are exposed as an output so callers
 * can store them in GCP Secret Manager.
 */
export class MachineUserComponent extends pulumi.ComponentResource {
	/** The Zitadel Machine User resource. */
	public readonly machineUser: zitadel.MachineUser

	/** The Machine Key containing the JWT private key. */
	public readonly machineKey: zitadel.MachineKey

	/** The org membership granting ORG_USER_MANAGER role. */
	public readonly orgMember: zitadel.OrgMember

	/**
	 * The JWT profile JSON for authenticating as this machine user.
	 * Must be stored in GCP Secret Manager — never log or expose directly.
	 */
	public readonly keyDetails: pulumi.Output<string>

	constructor(
		name: string,
		args: MachineUserComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:MachineUser', name, {}, opts)

		const { orgId, provider } = args
		const resourceOptions = { provider, parent: this }

		this.machineUser = new zitadel.MachineUser(
			'backend-app',
			{
				orgId,
				userName: 'backend-app',
				name: 'Backend App',
				description:
					'Service account for backend API server to call Zitadel Management APIs',
				accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
			},
			resourceOptions,
		)

		this.machineKey = new zitadel.MachineKey(
			'backend-app-key',
			{
				orgId,
				userId: this.machineUser.id,
				keyType: 'KEY_TYPE_JSON',
				// Effectively never expires for dev. The far-future date
				// avoids the "silent breakage on day N" failure mode that a
				// short expiration would create — there is no automated
				// rotation path here today, so an expired key would lock
				// out the backend until manual rotation. For prod (when the
				// self-hosted cutover extends beyond dev) this MUST be
				// replaced with a real expiration + rotation runbook.
				//
				// Bumped from a magic placeholder ('2519-04-01T08:45:00Z',
				// the upstream example value) to a clean far-future date.
				// The change also force-replaces the MachineKey, which is
				// intentional in this PR: state drift from the post-cutover
				// merged-state import left GSM holding a stale Cloud-era
				// key that does not match any AuthNKey row in the
				// self-hosted Zitadel DB, so backend → Zitadel API calls
				// (e.g. ResendEmailVerification) fail with `Errors.Internal
				// (OIDC-AhX2u) parent: Errors.AuthNKey.NotFound`. Replacing
				// the MachineKey re-mints the key, propagates fresh
				// keyDetails into the GSM SecretVersion, and aligns all
				// three sources of truth (Zitadel DB, GSM, Pulumi state).
				expirationDate: '2099-01-01T00:00:00Z',
			},
			{ ...resourceOptions, dependsOn: [this.machineUser] },
		)

		this.orgMember = new zitadel.OrgMember(
			'backend-app-member',
			{
				orgId,
				userId: this.machineUser.id,
				roles: ['ORG_USER_MANAGER'],
			},
			{ ...resourceOptions, dependsOn: [this.machineUser] },
		)

		this.keyDetails = this.machineKey.keyDetails

		this.registerOutputs({
			machineUser: this.machineUser,
			machineKey: this.machineKey,
			orgMember: this.orgMember,
			keyDetails: this.keyDetails,
		})
	}
}
