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
 *   3. Look up the first-boot "admin" org via `zitadel.getOrgsOutput`
 *      (design D2). Pulumi does NOT create the org — it was auto-created by
 *      `ZITADEL_FIRSTINSTANCE_ORG_NAME` at first boot; owning it would
 *      create a destroy-cascade hazard. Lookup asserts exactly one result.
 *   4. Instantiate the existing `MachineUserComponent` to create the
 *      backend `MachineUser` + `MachineKey` + `OrgMember` (ORG_USER_MANAGER
 *      role) inside the resolved org.
 *   5. Write the resulting JWT-profile JSON to a SEPARATE GSM Secret
 *      `zitadel-machine-key-for-backend-app` (wrapped in `pulumi.secret()`
 *      to prevent state leakage). ESO will mirror this Secret into the
 *      backend namespace via the existing ExternalSecret CR; Reloader rolls
 *      the backend Deployment.
 *
 * Blast-radius separation preserved: the org-admin JWT is consumed only by
 * the Zitadel provider at plan/apply time and never reaches a Pod; the
 * derived lower-privilege MachineKey JWT is what backend mounts at runtime
 * (per `prod-k8s-manifests` round-12 fix).
 */
export class BackendMachineKeyComponent extends pulumi.ComponentResource {
	public readonly provider: zitadel.Provider
	public readonly machineUser: MachineUserComponent
	public readonly secret: gcp.secretmanager.Secret
	public readonly secretVersion: gcp.secretmanager.SecretVersion
	public readonly secretAccessorBinding: gcp.secretmanager.SecretIamMember

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

		// Look up the first-boot "admin" org by name. `getOrg` (singular)
		// requires id; `getOrgs` (plural) supports name-based query and
		// returns `ids: string[]`. Assert exactly one match before using —
		// refuse to guess on ambiguity.
		const adminOrgs = zitadel.getOrgsOutput(
			{
				name: 'admin',
				nameMethod: 'TEXT_QUERY_METHOD_EQUALS',
				state: 'ORG_STATE_ACTIVE',
			},
			{ provider: this.provider, parent: this },
		)

		const adminOrgId = adminOrgs.apply((result) => {
			if (!result.ids || result.ids.length === 0) {
				throw new Error(
					`zitadel.getOrgs returned zero ACTIVE orgs named 'admin' against ${zitadelDomainMap[env]}. ` +
						'Expected the first-boot bootstrap to have created this org. ' +
						'Check Zitadel API logs and `ZITADEL_FIRSTINSTANCE_ORG_NAME` in the configmap.',
				)
			}
			if (result.ids.length > 1) {
				throw new Error(
					`zitadel.getOrgs returned ${result.ids.length} orgs named 'admin' ` +
						`(ids: ${result.ids.join(', ')}). Expected exactly one — refuse ` +
						'to guess which is the first-boot org. Inspect Zitadel and either ' +
						'delete the stale orgs or switch this lookup to a unique discriminator.',
				)
			}
			return result.ids[0]
		})

		this.machineUser = new MachineUserComponent(
			name,
			{ orgId: adminOrgId, provider: this.provider },
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

		this.registerOutputs({
			provider: this.provider,
			machineUser: this.machineUser,
			secret: this.secret,
			secretVersion: this.secretVersion,
			secretAccessorBinding: this.secretAccessorBinding,
			keyDetails: this.keyDetails,
		})
	}
}
