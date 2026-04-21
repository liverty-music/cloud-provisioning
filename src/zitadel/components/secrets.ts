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

		this.registerOutputs({
			masterkeySecretId: this.masterkeySecret.secretId,
			adminSaKeySecretId: this.adminSaKeySecret.secretId,
		})
	}
}
