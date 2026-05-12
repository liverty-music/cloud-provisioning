import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'

export interface SecretsComponentArgs {
	project: gcp.organizations.Project
	/** GCP SA email that Zitadel pods impersonate via Workload Identity. */
	zitadelServiceAccountEmail: pulumi.Input<string>
	/** GCP SA email that the ESO controller uses to read secrets. */
	esoServiceAccountEmail: pulumi.Input<string>
}

/**
 * SecretsComponent provisions the two GSM secrets that self-hosted Zitadel
 * requires and wires the narrow IAM bindings they need.
 *
 * - `zitadel-masterkey`: 32 alphanumeric bytes, generated once, never rotated.
 *   Pulumi creates the version immediately. ESO reads it. Zitadel pods mount
 *   it from an ExternalSecret-managed Kubernetes secret.
 * - `zitadel-admin-sa-key`: Empty secret shell at creation time. The first
 *   Zitadel pod boot writes its FIRSTINSTANCE-generated admin machine JSON
 *   key into the secret via a sidecar bootstrap Job (which uses the zitadel
 *   SA's `secretmanager.secretVersionAdder` binding below). Pulumi reads the
 *   populated value on a subsequent stack apply to configure the Zitadel
 *   provider in `@pulumiverse/zitadel`.
 */
export class SecretsComponent extends pulumi.ComponentResource {
	public readonly masterkeySecret: gcp.secretmanager.Secret
	public readonly adminSaKeySecret: gcp.secretmanager.Secret
	/**
	 * New GSM secret following the platform-wide convention
	 * `zitadel-machine-key-for-<principal>`. During the rename transition
	 * (openspec change rename-zitadel-machine-keys), `bootstrap-uploader`
	 * writes the same JSON key payload to both `adminSaKeySecret` and this
	 * secret. The legacy `adminSaKeySecret` is destroyed in the cleanup PR.
	 */
	public readonly pulumiAdminMachineKeySecret: gcp.secretmanager.Secret

	constructor(
		name: string,
		args: SecretsComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:Secrets', name, {}, opts)

		const { project, zitadelServiceAccountEmail, esoServiceAccountEmail } =
			args

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

		// admin-sa-key: empty shell at creation; populated by the in-cluster
		// bootstrap Job on first Zitadel boot. ESO reads the latest version
		// once it lands; the Zitadel SA holds only `secretVersionAdder` (write)
		// to avoid exposing the key back to the Zitadel runtime.
		this.adminSaKeySecret = new gcp.secretmanager.Secret(
			'zitadel-admin-sa-key',
			{
				secretId: 'zitadel-admin-sa-key',
				project: project.projectId,
				replication: { auto: {} },
			},
			{ parent: this },
		)

		// Transitional second secret shell during the rename from
		// `zitadel-admin-sa-key` to `zitadel-machine-key-for-pulumi-admin`
		// (openspec change rename-zitadel-machine-keys). Same lifecycle as
		// `adminSaKeySecret`: empty shell at creation, populated by the
		// bootstrap-uploader sidecar (which now dual-writes to both names).
		// The legacy `adminSaKeySecret` is removed in the cleanup PR.
		this.pulumiAdminMachineKeySecret = new gcp.secretmanager.Secret(
			'zitadel-machine-key-for-pulumi-admin',
			{
				secretId: 'zitadel-machine-key-for-pulumi-admin',
				project: project.projectId,
				replication: { auto: {} },
			},
			{ parent: this },
		)

		// ESO read access on both secrets.
		new gcp.secretmanager.SecretIamMember(
			'zitadel-masterkey-eso-accessor',
			{
				secretId: this.masterkeySecret.secretId,
				project: project.projectId,
				role: 'roles/secretmanager.secretAccessor',
				member: pulumi.interpolate`serviceAccount:${esoServiceAccountEmail}`,
			},
			{ parent: this },
		)

		new gcp.secretmanager.SecretIamMember(
			'zitadel-admin-sa-key-eso-accessor',
			{
				secretId: this.adminSaKeySecret.secretId,
				project: project.projectId,
				role: 'roles/secretmanager.secretAccessor',
				member: pulumi.interpolate`serviceAccount:${esoServiceAccountEmail}`,
			},
			{ parent: this },
		)

		// Same ESO read binding on the new transitional secret.
		new gcp.secretmanager.SecretIamMember(
			'zitadel-machine-key-for-pulumi-admin-eso-accessor',
			{
				secretId: this.pulumiAdminMachineKeySecret.secretId,
				project: project.projectId,
				role: 'roles/secretmanager.secretAccessor',
				member: pulumi.interpolate`serviceAccount:${esoServiceAccountEmail}`,
			},
			{ parent: this },
		)

		// Zitadel bootstrap Job write access on admin-sa-key only. The narrower
		// `secretVersionAdder` role allows adding new versions without exposing
		// read access to already-stored versions.
		new gcp.secretmanager.SecretIamMember(
			'zitadel-admin-sa-key-zitadel-writer',
			{
				secretId: this.adminSaKeySecret.secretId,
				project: project.projectId,
				role: 'roles/secretmanager.secretVersionAdder',
				member: pulumi.interpolate`serviceAccount:${zitadelServiceAccountEmail}`,
			},
			{ parent: this },
		)

		// Same Zitadel write binding on the new transitional secret so the
		// bootstrap-uploader sidecar can dual-write the JWT key payload.
		new gcp.secretmanager.SecretIamMember(
			'zitadel-machine-key-for-pulumi-admin-zitadel-writer',
			{
				secretId: this.pulumiAdminMachineKeySecret.secretId,
				project: project.projectId,
				role: 'roles/secretmanager.secretVersionAdder',
				member: pulumi.interpolate`serviceAccount:${zitadelServiceAccountEmail}`,
			},
			{ parent: this },
		)

		this.registerOutputs({
			masterkeySecretId: this.masterkeySecret.secretId,
			adminSaKeySecretId: this.adminSaKeySecret.secretId,
			pulumiAdminMachineKeySecretId:
				this.pulumiAdminMachineKeySecret.secretId,
		})
	}
}
