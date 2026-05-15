import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import { zitadelDomainMap } from '../constants.js'
import { MachineUserComponent } from './machine-user.js'

export interface BackendMachineKeyComponentArgs {
	/** Pulumi stack environment. Drives the Zitadel provider's `domain`
	 *  (via `zitadelDomainMap[env]`) and the Zitadel provider resource name
	 *  (`zitadel-${env}`). Dev currently keeps its existing Zitadel-class-routed
	 *  flow; this component is intentionally prod-shaped (provider + admin
	 *  org lookup + GSM bundle) so the prod call site is a single expressive
	 *  line and dev URNs remain untouched. */
	env: Environment

	/** GCP project that owns BOTH (a) the admin JWT GSM Secret
	 *  `zitadel-machine-key-for-pulumi-admin` consumed at plan time and (b)
	 *  the new `zitadel-machine-key-for-backend-app` GSM Secret + IAM bindings
	 *  this component creates. */
	gcpProject: pulumi.Input<string>

	/** ESO Workload Identity GCP SA email that needs read access to the new
	 *  GSM Secret. Defaults to the platform convention
	 *  `k8s-external-secrets@<gcpProject>.iam.gserviceaccount.com`. */
	esoServiceAccountEmail?: pulumi.Input<string>
}

/**
 * BackendMachineKeyComponent provisions the backend's machine-user JWT-profile
 * for a self-hosted Zitadel installation, plus the GSM Secret + SecretVersion
 * + IAM accessor that ESO uses to mirror the JWT into the backend namespace
 * (per `zitadel-self-hosted-deployment` spec "Backend MachineKey Lifecycle"
 * requirement).
 *
 * The component owns the full orchestration end-to-end so the `index.ts` call
 * site stays as a thin dispatch line (per CLAUDE.md "Main entry point
 * dispatching to GCP and GitHub components"):
 *
 *   1. Read the admin JWT (`zitadel-machine-key-for-pulumi-admin`) from GSM
 *      via `getSecretVersionAccessOutput`. The JWT is wrapped in
 *      `pulumi.secret()` to prevent the embedded RSA private key from
 *      leaking into preview/state/CI logs (design D3 + the dev path's
 *      CRITICAL comment in `src/zitadel/index.ts`).
 *   2. Create a `zitadel.Provider` targeting `zitadelDomainMap[env]`
 *      (e.g., `auth.liverty-music.app` for prod). The domain uses the
 *      central map to avoid drift between this file and the constants.
 *   3. Create a NEW `liverty-music` product org via `zitadel.Org` (matching
 *      dev's two-org topology). The backend MachineUser lives here, NOT in
 *      the first-boot "admin" org — placing `backend-app` (with its
 *      ORG_USER_MANAGER role) in the admin org would give the runtime
 *      backend Pod user-management authority over operator identities
 *      (pulumi-admin, login-client, human IAM_OWNER admins). Per the
 *      `Place Machine Users by Responsibility` rule. Pulumi does NOT touch
 *      the first-boot "admin" org — that one was auto-created by
 *      `ZITADEL_FIRSTINSTANCE_ORG_NAME` and owning it would create a
 *      destroy-cascade hazard.
 *   4. Instantiate the existing `MachineUserComponent` inside the product
 *      org to create the backend `MachineUser` + `MachineKey` + `OrgMember`
 *      (ORG_USER_MANAGER role scoped to the product org).
 *   5. Write the resulting JWT-profile JSON to a SEPARATE GSM Secret
 *      `zitadel-machine-key-for-backend-app` (wrapped in `pulumi.secret()`
 *      to prevent state leakage). ESO will mirror this Secret into the
 *      backend namespace via the existing ExternalSecret CR; Reloader rolls
 *      the backend Deployment.
 *
 * Blast-radius separation preserved on two axes: (a) the org-admin JWT is
 * consumed only by the Zitadel provider at plan/apply time and never reaches
 * a Pod (per `prod-k8s-manifests` round-12 fix); (b) the backend MachineUser
 * is scoped to the product org and cannot reach the admin org's operator
 * identities (this component's design).
 */
export class BackendMachineKeyComponent extends pulumi.ComponentResource {
	public readonly provider: zitadel.Provider
	public readonly productOrg: zitadel.Org
	public readonly machineUser: MachineUserComponent
	public readonly secret: gcp.secretmanager.Secret
	public readonly secretVersion: gcp.secretmanager.SecretVersion
	public readonly secretAccessorBinding: gcp.secretmanager.SecretIamMember

	/** Admin (`pulumi-admin`) JWT-profile JSON read from GSM
	 *  `zitadel-machine-key-for-pulumi-admin` at plan time, wrapped in
	 *  `pulumi.secret()`. Exposed so sibling components needing direct
	 *  Zitadel Management API calls outside the @pulumiverse provider
	 *  surface (SmtpComponent activation, ActionsV2Component Target /
	 *  Execution dynamic resources, HumanAdminComponent IdP-link dynamic
	 *  resource) can re-use the same secret-wrapped value rather than
	 *  re-fetching it from GSM. Never log directly. */
	public readonly adminJwt: pulumi.Output<string>

	/** The JWT-profile JSON for authenticating as the backend machine user.
	 *  Stored in GSM via this component; exposed here for callers that want
	 *  to test or reference it programmatically. Never log directly. */
	public readonly keyDetails: pulumi.Output<string>

	constructor(
		name: string,
		args: BackendMachineKeyComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:BackendMachineKey', name, {}, opts)

		const { env, gcpProject } = args
		const esoServiceAccountEmail =
			args.esoServiceAccountEmail ??
			pulumi
				.output(gcpProject)
				.apply(
					(p) => `k8s-external-secrets@${p}.iam.gserviceaccount.com`,
				)

		// CRITICAL: wrap the admin JWT in `pulumi.secret()`.
		// `getSecretVersionAccessOutput` does NOT auto-mark its output as
		// secret. The JWT-profile JSON embeds an RSA private key — without
		// this wrap, the key value would surface in plaintext in `pulumi
		// preview` output (including Pulumi Cloud PR previews), CI logs,
		// and Pulumi service state history. Matches the analogous CRITICAL
		// guard in `src/zitadel/index.ts`'s dev path.
		const adminJwt = pulumi.secret(
			gcp.secretmanager
				.getSecretVersionAccessOutput({
					project: gcpProject,
					secret: 'zitadel-machine-key-for-pulumi-admin',
				})
				.apply((v) => v.secretData),
		)

		this.provider = new zitadel.Provider(
			`zitadel-${env}`,
			{
				domain: zitadelDomainMap[env],
				insecure: false,
				port: '443',
				jwtProfileJson: adminJwt,
			},
			{ parent: this },
		)

		// Product org — Pulumi-created, scoped to backend app workloads.
		// NOT the first-boot "admin" org (which the bootstrap auto-created
		// and holds operator identities: pulumi-admin, login-client, human
		// IAM_OWNERs). Mirrors dev's `productOrg` topology so backend-app's
		// ORG_USER_MANAGER role grants user-management only over end-user
		// principals in this org — never over operator identities.
		this.productOrg = new zitadel.Org(
			'liverty-music',
			{ name: 'liverty-music', isDefault: false },
			{ provider: this.provider, parent: this },
		)

		this.machineUser = new MachineUserComponent(
			name,
			{ orgId: this.productOrg.id, provider: this.provider },
			{ parent: this },
		)

		this.secret = new gcp.secretmanager.Secret(
			'zitadel-machine-key-for-backend-app',
			{
				project: gcpProject,
				secretId: 'zitadel-machine-key-for-backend-app',
				replication: { auto: {} },
				labels: { env, managed_by: 'pulumi' },
			},
			{ parent: this },
		)

		this.secretVersion = new gcp.secretmanager.SecretVersion(
			'zitadel-machine-key-for-backend-app-version',
			{
				secret: this.secret.id,
				// CRITICAL: wrap the MachineKey JWT in `pulumi.secret()`.
				// `MachineKey.keyDetails` is a plain `Output<string>` — the
				// `@pulumiverse/zitadel` provider does NOT mark it secret.
				// Without this wrap the RSA private key embedded in the
				// backend machine-user JWT-profile JSON would surface in
				// plaintext in Pulumi state history for the SecretVersion
				// input diff. Same protection as the dev path applies in
				// `src/gcp/index.ts` (`pulumi.secret(zitadelMachineKey)`).
				secretData: pulumi.secret(this.machineUser.keyDetails),
				deletionPolicy: 'DELETE',
				enabled: true,
			},
			{ parent: this },
		)

		this.secretAccessorBinding = new gcp.secretmanager.SecretIamMember(
			'zitadel-machine-key-for-backend-app-eso-accessor',
			{
				project: gcpProject,
				secretId: this.secret.secretId,
				role: 'roles/secretmanager.secretAccessor',
				member: pulumi
					.output(esoServiceAccountEmail)
					.apply((m) =>
						m.startsWith('serviceAccount:')
							? m
							: `serviceAccount:${m}`,
					),
			},
			{ parent: this },
		)

		this.keyDetails = this.machineUser.keyDetails
		this.adminJwt = adminJwt

		this.registerOutputs({
			provider: this.provider,
			productOrg: this.productOrg,
			machineUser: this.machineUser,
			secret: this.secret,
			secretVersion: this.secretVersion,
			secretAccessorBinding: this.secretAccessorBinding,
			adminJwt: this.adminJwt,
			keyDetails: this.keyDetails,
		})
	}
}
