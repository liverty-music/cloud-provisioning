import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'

export interface WatchdogProbeComponentArgs {
	/**
	 * Product org ID. The machine user is placed here — co-located with the
	 * project it probes — so the `ProjectMember` grant is a native same-org
	 * membership (Zitadel `ProjectMember` requires the user and project to share
	 * a resource-owner org; a cross-org grant would need a `ProjectGrant` first).
	 */
	productOrgId: pulumi.Input<string>
	/** ID of the liverty-music product project to probe. */
	productProjectId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * WatchdogProbeComponent provisions a dedicated least-privilege Zitadel Machine
 * User and Personal Access Token for the self-healing watchdog CronJob.
 *
 * The machine user calls `ProjectService/ListProjectRoles` (Connect/gRPC, HTTP+JSON)
 * on the prod `liverty-music` project. That method internally calls
 * `SearchProjectRoles(…, shouldTriggerBulk=true, …)`, triggering
 * `ProjectRoleProjection.Trigger(WithAwaitRunning())` — the exact projection
 * that wedged on 2026-06-23. A hang on this call (curl HTTP 000) is the wedge
 * signal; a fast 200 means healthy. The probe is a pure read: no eventstore
 * write, no OIDC auth-request accumulation.
 *
 * Minimum privilege: `PROJECT_OWNER_VIEWER` on the product project only.
 * If `ListProjectRoles` returns `401`/`403`, the watchdog logs "watchdog
 * credential invalid" and treats the run as healthy (fail-safe, no false restart).
 *
 * The PAT is long-lived (expires 2099) and delivered to the CronJob via GSM →
 * ExternalSecret → K8s Secret mount.
 */
export class WatchdogProbeComponent extends pulumi.ComponentResource {
	public readonly machineUser: zitadel.MachineUser

	/** Minimum-privilege membership: PROJECT_OWNER_VIEWER on the product project. */
	public readonly projectMember: zitadel.ProjectMember

	/** Long-lived PAT for the watchdog CronJob bearer token. */
	public readonly pat: zitadel.PersonalAccessToken

	/** PAT value — callers MUST wrap in `pulumi.secret()` before storing. */
	public readonly token: pulumi.Output<string>

	constructor(
		name: string,
		args: WatchdogProbeComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:WatchdogProbe', name, {}, opts)

		const { productOrgId, productProjectId, provider } = args
		const resourceOptions = { provider, parent: this }

		this.machineUser = new zitadel.MachineUser(
			'watchdog-probe',
			{
				orgId: productOrgId,
				userName: 'watchdog-probe',
				name: 'Watchdog Probe',
				description:
					'Least-privilege probe identity for the self-healing watchdog CronJob. ' +
					'Calls ProjectService/ListProjectRoles (read-only) to detect the ' +
					'Zitadel projection-trigger wedge (zitadel#10103) without writing ' +
					'to the eventstore. Stopgap until upstream fixes the wedge.',
				accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
			},
			resourceOptions,
		)

		// Minimal role: PROJECT_OWNER_VIEWER grants read-only access to the
		// project and its role list. This is the minimum role that allows
		// ListProjectRoles to return 200 rather than 403. Same-org membership
		// (user + project both in the product org).
		this.projectMember = new zitadel.ProjectMember(
			'watchdog-probe-project-member',
			{
				orgId: productOrgId,
				projectId: productProjectId,
				userId: this.machineUser.id,
				roles: ['PROJECT_OWNER_VIEWER'],
			},
			{ ...resourceOptions, dependsOn: [this.machineUser] },
		)

		// PAT with far-future expiry. Long-lived by design (same rationale as
		// MachineUserComponent.machineKey) — there is no automated rotation path;
		// expiry is tracked via the runbook. The fail-safe is preserved: an
		// expired PAT produces a fast 401 which the watchdog reads as "healthy"
		// (no false restart), so it degrades gracefully to "no detection" rather
		// than "restart loop".
		this.pat = new zitadel.PersonalAccessToken(
			'watchdog-probe-pat',
			{
				orgId: productOrgId,
				userId: this.machineUser.id,
				expirationDate: '2099-01-01T00:00:00Z',
			},
			{ ...resourceOptions, dependsOn: [this.projectMember] },
		)

		this.token = this.pat.token

		this.registerOutputs({
			machineUser: this.machineUser,
			projectMember: this.projectMember,
			pat: this.pat,
			token: this.token,
		})
	}
}
