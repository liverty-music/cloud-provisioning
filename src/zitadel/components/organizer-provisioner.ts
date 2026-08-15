import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'

export interface OrganizerProvisionerComponentArgs {
	/**
	 * Org to host the machine user. The role granted below is instance-wide, so
	 * org choice is purely organizational; we co-locate it in the product org
	 * with the other backend service identity (`backend-app`) because the
	 * backend Go service consumes this credential at runtime. Isolation from
	 * `backend-app` is by identity + role (a distinct user with a far broader
	 * instance role), not by org.
	 */
	orgId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * OrganizerProvisionerComponent provisions the dedicated machine user the
 * backend uses at runtime to provision Organizer tenant orgs: creating one
 * Zitadel Organization per vetted Organizer and wiring its cross-org Project
 * Grant (to the product org's `organizer-console` project) and the operator's
 * User Grant.
 *
 * ## Least privilege: IAM_ORG_MANAGER, not IAM_OWNER
 *
 * Creating orgs + cross-org grants needs instance-level rights far broader than
 * the existing single-org `backend-app` user (`ORG_USER_MANAGER` on one org).
 * `IAM_ORG_MANAGER` is the narrowest instance role that still permits
 * org.create and management within any org (Project Grants, User Grants) — it
 * is strictly less than `IAM_OWNER` (full instance control, held only by the
 * bootstrap `pulumi-admin` SA). A dedicated user isolates this blast radius
 * from `backend-app`. This resolves the design's Open Question on the exact
 * role. See OpenSpec change `organizer-tenancy`, design D3.
 *
 * ## Credential — immutable root key (operational tokens are already short-lived)
 *
 * A JSON MachineKey (JWT profile) is created and exposed as `keyDetails`; the
 * caller stores it in GCP Secret Manager (never logs it). The backend
 * authenticates with this key via the standard `jwt-bearer` grant, through
 * which Zitadel issues **short-lived access tokens** by the normal OAuth flow
 * (`accessTokenType = JWT`; lifetime from the instance `DefaultOidcSettings`,
 * currently 30m). That short-lived-token behaviour is inherent to any machine
 * user — there is no long-lived opaque bearer / PAT stored and nothing bespoke
 * to build.
 *
 * The key itself is **effectively non-expiring** (far-future date), matching the
 * `backend-app` key. A finite expiry was considered to bound leak exposure, but
 * Zitadel machine keys (JWT profile) have **no native auto-rotation** and no
 * keyless (workload-identity-federation) alternative for machine users, so a
 * finite expiry would force **manual** rotation — a "silent breakage on day N"
 * outage the moment a rotation is missed. That operational time bomb is strictly
 * worse than the residual risk of a long-lived key here, which is contained by
 * three compensating controls:
 *   1. GCP-layer least privilege — the key's GSM secret grants `secretAccessor`
 *      to a single dedicated GSA (`admin-console-api`); `backend-app` cannot read
 *      it. Only the isolated admin workload can load it. (organizer-accounts.)
 *   2. Operational tokens are already short-lived (30m access tokens via the
 *      jwt-bearer flow) — the stored root key is never sent to APIs directly.
 *   3. Instant revocation — if the key leaks, force-replacing this MachineKey
 *      (a one-line change here) re-mints it and invalidates the old key.
 * Automated rotation / workload-identity federation remains the target
 * end-state; adopt it here if and when Zitadel supports it.
 */
export class OrganizerProvisionerComponent extends pulumi.ComponentResource {
	public readonly machineUser: zitadel.MachineUser

	/** Instance-level membership granting IAM_ORG_MANAGER (org-create + grants). */
	public readonly instanceMember: zitadel.InstanceMember

	/** The Machine Key containing the JWT private key. */
	public readonly machineKey: zitadel.MachineKey

	/**
	 * JWT profile JSON for authenticating as this machine user. Callers MUST
	 * store it in GCP Secret Manager and never log or expose it directly.
	 */
	public readonly keyDetails: pulumi.Output<string>

	constructor(
		name: string,
		args: OrganizerProvisionerComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:OrganizerProvisioner', name, {}, opts)

		const { orgId, provider } = args
		const resourceOptions = { provider, parent: this }

		this.machineUser = new zitadel.MachineUser(
			'organizer-provisioner',
			{
				orgId,
				userName: 'organizer-provisioner',
				name: 'Organizer Provisioner',
				description:
					'Service account the backend uses at runtime to provision ' +
					'Organizer tenant orgs (org-create + cross-org Project/User ' +
					'Grants). Granted IAM_ORG_MANAGER at instance level; isolated ' +
					'from the single-org backend-app user for blast-radius control.',
				accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
			},
			resourceOptions,
		)

		// IAM_ORG_MANAGER at instance level — the narrowest role permitting
		// org.create and cross-org Project/User Grants. See component docstring.
		this.instanceMember = new zitadel.InstanceMember(
			'organizer-provisioner-member',
			{
				userId: this.machineUser.id,
				roles: ['IAM_ORG_MANAGER'],
			},
			{ ...resourceOptions, dependsOn: [this.machineUser] },
		)

		// JSON MachineKey, effectively non-expiring (far-future) — see the
		// credential section of the component docstring. The backend
		// authenticates with this key via the standard jwt-bearer flow (Zitadel
		// issues short-lived access tokens). Zitadel machine keys have no native
		// rotation, so a finite expiry would force manual rotation (an outage
		// time bomb); the powerful root key is instead contained by GCP-layer
		// isolation (sole reader is the admin-console-api GSA) + short-lived
		// operational tokens + instant force-replace revocation.
		this.machineKey = new zitadel.MachineKey(
			'machine-key-for-organizer-provisioner',
			{
				orgId,
				userId: this.machineUser.id,
				keyType: 'KEY_TYPE_JSON',
				expirationDate: '2099-01-01T00:00:00Z',
			},
			{ ...resourceOptions, dependsOn: [this.machineUser] },
		)

		this.keyDetails = this.machineKey.keyDetails

		this.registerOutputs({
			machineUser: this.machineUser,
			instanceMember: this.instanceMember,
			machineKey: this.machineKey,
			keyDetails: this.keyDetails,
		})
	}
}
