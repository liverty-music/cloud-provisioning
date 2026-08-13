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
 * ## Credential — finite root key (operational tokens are already short-lived)
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
 * The security delta over the existing `backend-app` "expires 2099" pattern is
 * therefore the **root key's own lifecycle**: because this identity is
 * high-privilege, its key carries a **finite expiry** (not year-2099) so it
 * cannot live forever if leaked. There is no automated rotation yet, so a
 * documented rotation runbook is the compensating control — authored in
 * `organizer-accounts`, where the key is first consumed (design D3). Automated
 * rotation / workload-identity federation is the target end-state. The finite
 * expiry is deliberately comfortable (rotation cadence, not a surprise
 * outage) — rotate before it.
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

		// JSON MachineKey with a FINITE expiry (not year-2099) — see the
		// credential section of the component docstring. The backend
		// authenticates with this key via the standard jwt-bearer flow (Zitadel
		// issues short-lived access tokens); the finite root-key expiry bounds
		// leak exposure and forces eventual rotation (runbook in
		// organizer-accounts, no automation yet).
		this.machineKey = new zitadel.MachineKey(
			'machine-key-for-organizer-provisioner',
			{
				orgId,
				userId: this.machineUser.id,
				keyType: 'KEY_TYPE_JSON',
				// ~1 year from this change (2026-08). Rotate before expiry per the
				// runbook; revisit once automated rotation / WIF lands.
				expirationDate: '2027-08-13T00:00:00Z',
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
