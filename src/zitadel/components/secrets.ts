import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'

export interface SecretsComponentArgs {
	project: gcp.organizations.Project
	/**
	 * Workload-tier service account emails. Provided when the cluster is
	 * up (Workload Identity SAs exist); the read/write IAM bindings on
	 * the masterkey + admin SA-key secrets are created only when this is
	 * set. The secret containers + versions themselves are always
	 * provisioned regardless, so the masterkey RandomString and any
	 * `bootstrap-uploader`-populated admin SA-key version survive a
	 * `workloadEnabled=false` cycle without being regenerated.
	 */
	workloadSAs?: {
		/** GCP SA email that Zitadel pods impersonate via Workload Identity. */
		zitadelEmail: pulumi.Input<string>
		/** GCP SA email that the ESO controller uses to read secrets. */
		esoEmail: pulumi.Input<string>
	}
}

/**
 * SecretsComponent provisions the GSM secrets that self-hosted Zitadel
 * requires and wires the narrow IAM bindings they need.
 *
 * - `zitadel-masterkey`: 32 alphanumeric bytes, generated once, never rotated.
 *   Pulumi creates the version immediately. ESO reads it. Zitadel pods mount
 *   it from an ExternalSecret-managed Kubernetes secret.
 * - `zitadel-machine-key-for-pulumi-admin`: Empty secret shell at creation
 *   time. The first Zitadel pod boot writes its FIRSTINSTANCE-generated
 *   admin machine JSON key into the secret via the in-pod `bootstrap-uploader`
 *   sidecar (which uses the zitadel SA's `secretmanager.secretVersionAdder`
 *   binding below). Pulumi reads the populated value on a subsequent stack
 *   apply to configure the Zitadel provider in `@pulumiverse/zitadel`.
 */
export class SecretsComponent extends pulumi.ComponentResource {
	public readonly masterkeySecret: gcp.secretmanager.Secret
	/** GSM secret holding the `pulumi-admin` MachineUser's JWT-profile JSON.
	 *  Follows the platform-wide convention `zitadel-machine-key-for-<principal>`. */
	public readonly pulumiAdminMachineKeySecret: gcp.secretmanager.Secret

	constructor(
		name: string,
		args: SecretsComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:Secrets', name, {}, opts)

		const { project, workloadSAs } = args

		// Masterkey: 32 alphanumeric characters. RandomString persists the value
		// in Pulumi state so re-applying the stack yields the same masterkey.
		// `special: false` keeps the output shell-safe for env-var injection.
		const masterkey = new random.RandomString(
			'zitadel-masterkey',
			{
				length: 32,
				special: false,
				upper: true,
				lower: true,
				numeric: true,
			},
			{ parent: this },
		)

		this.masterkeySecret = new gcp.secretmanager.Secret(
			'zitadel-masterkey',
			{
				secretId: 'zitadel-masterkey',
				project: project.projectId,
				replication: { auto: {} },
			},
			{ parent: this },
		)

		new gcp.secretmanager.SecretVersion(
			'zitadel-masterkey-version',
			{
				secret: this.masterkeySecret.id,
				secretData: masterkey.result,
			},
			{ parent: this },
		)

		// pulumi-admin MachineKey: empty shell at creation; populated by the
		// in-pod `bootstrap-uploader` sidecar on first Zitadel boot. ESO reads
		// the latest version once it lands; the Zitadel SA holds only
		// `secretVersionAdder` (write) to avoid exposing the key back to the
		// Zitadel runtime.
		this.pulumiAdminMachineKeySecret = new gcp.secretmanager.Secret(
			'zitadel-machine-key-for-pulumi-admin',
			{
				secretId: 'zitadel-machine-key-for-pulumi-admin',
				project: project.projectId,
				replication: { auto: {} },
			},
			{ parent: this },
		)

		// IAM bindings are workload-tier-scoped: the cluster Service
		// Accounts they reference only exist while `workloadEnabled`. The
		// secret containers + versions above always persist; only the
		// access bindings are torn down/re-created across shutdown cycles.
		if (workloadSAs) {
			// ESO read access on both secrets.
			new gcp.secretmanager.SecretIamMember(
				'zitadel-masterkey-eso-accessor',
				{
					secretId: this.masterkeySecret.secretId,
					project: project.projectId,
					role: 'roles/secretmanager.secretAccessor',
					member: pulumi.interpolate`serviceAccount:${workloadSAs.esoEmail}`,
				},
				{ parent: this },
			)

			new gcp.secretmanager.SecretIamMember(
				'zitadel-machine-key-for-pulumi-admin-eso-accessor',
				{
					secretId: this.pulumiAdminMachineKeySecret.secretId,
					project: project.projectId,
					role: 'roles/secretmanager.secretAccessor',
					member: pulumi.interpolate`serviceAccount:${workloadSAs.esoEmail}`,
				},
				{ parent: this },
			)

			// Zitadel bootstrap sidecar write access on the pulumi-admin key
			// only. The narrower `secretVersionAdder` role allows adding new
			// versions without exposing read access to already-stored versions.
			new gcp.secretmanager.SecretIamMember(
				'zitadel-machine-key-for-pulumi-admin-zitadel-writer',
				{
					secretId: this.pulumiAdminMachineKeySecret.secretId,
					project: project.projectId,
					role: 'roles/secretmanager.secretVersionAdder',
					member: pulumi.interpolate`serviceAccount:${workloadSAs.zitadelEmail}`,
				},
				{ parent: this },
			)
		}

		this.registerOutputs({
			masterkeySecretId: this.masterkeySecret.secretId,
			pulumiAdminMachineKeySecretId:
				this.pulumiAdminMachineKeySecret.secretId,
		})
	}
}
