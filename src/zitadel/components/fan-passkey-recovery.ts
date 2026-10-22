import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'

export interface FanPasskeyRecoveryComponentArgs {
	/** The product org: it hosts the fans' identities, and the role below is
	 *  granted on it. */
	orgId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * FanPasskeyRecoveryComponent provisions the dedicated machine user the event
 * consumer uses to issue passkey registration links for fans who lost their
 * passkeys (User v2 `CreatePasskeyRegistrationLink` with `returnCode`). See
 * OpenSpec change `fan-passkey-recovery-and-management`, design D2.
 *
 * ## Why ORG_OWNER on the product org
 *
 * `CreatePasskeyRegistrationLink` requires `user.passkey.write` on the target
 * user's organization. Among org roles only `ORG_OWNER` grants it;
 * `ORG_USER_MANAGER` (held by `backend-app`) does not (zitadel#12270). Adding
 * the permission to `ORG_USER_MANAGER` would mean overriding the whole
 * `InternalAuthZ.RolePermissionMappings` list, which drifts on every upgrade.
 *
 * ## Isolation
 *
 * The key is stored in Secret Manager as
 * `zitadel-machine-key-for-fan-passkey-recovery`, readable only by the ESO
 * controller, synced into its own Kubernetes Secret and mounted only on
 * `event-consumer`, which takes no inbound internet traffic. It is never
 * mounted on the internet-facing `fan-api`. Like the `backend-app` and
 * `organizer-provisioner` keys it is effectively non-expiring (far-future
 * date): Zitadel machine keys have no native rotation, operational tokens are
 * short-lived (jwt-bearer grant), and force-replacing the MachineKey revokes
 * it at once.
 */
export class FanPasskeyRecoveryComponent extends pulumi.ComponentResource {
	public readonly machineUser: zitadel.MachineUser

	/** The Machine Key containing the JWT private key. */
	public readonly machineKey: zitadel.MachineKey

	/** The product org membership granting ORG_OWNER. */
	public readonly orgMember: zitadel.OrgMember

	/**
	 * JWT profile JSON for authenticating as this machine user. Callers MUST
	 * store it in GCP Secret Manager and never log or expose it directly.
	 */
	public readonly keyDetails: pulumi.Output<string>

	constructor(
		name: string,
		args: FanPasskeyRecoveryComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:FanPasskeyRecovery', name, {}, opts)

		const { orgId, provider } = args
		const resourceOptions = { provider, parent: this }

		this.machineUser = new zitadel.MachineUser(
			'fan-passkey-recovery',
			{
				orgId,
				userName: 'fan-passkey-recovery',
				name: 'Fan Passkey Recovery',
				description:
					'Service account the event consumer uses to issue passkey ' +
					'registration links for fans who lost their passkeys. Granted ' +
					'ORG_OWNER on the product org (the only org role with ' +
					'user.passkey.write); mounted only on event-consumer.',
				accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
			},
			resourceOptions,
		)

		this.machineKey = new zitadel.MachineKey(
			'machine-key-for-fan-passkey-recovery',
			{
				orgId,
				userId: this.machineUser.id,
				keyType: 'KEY_TYPE_JSON',
				expirationDate: '2099-01-01T00:00:00Z',
			},
			{ ...resourceOptions, dependsOn: [this.machineUser] },
		)

		this.orgMember = new zitadel.OrgMember(
			'fan-passkey-recovery-member',
			{
				orgId,
				userId: this.machineUser.id,
				roles: ['ORG_OWNER'],
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
