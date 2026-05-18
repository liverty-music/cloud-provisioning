import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
import { ApiService } from '../services/api.js'

export interface KmsComponentArgs {
	project: gcp.organizations.Project
	region: pulumi.Input<string>
	/** Caller's environment — forwarded to `ApiService` so the
	 *  `cloudkms.googleapis.com` enable resource picks the correct
	 *  `disableOnDestroy` policy (`false` for dev, `true` for prod and
	 *  future envs). Today this component is only instantiated for prod,
	 *  but accepting the arg explicitly removes a latent footgun if KMS
	 *  is ever extended to other envs. */
	environment: Environment
}

/**
 * KmsComponent provisions a Cloud KMS keyring and CryptoKey used as the
 * customer-managed encryption key (CMEK) for the GKE cluster's etcd
 * Application-layer Secrets Encryption.
 *
 * The key encrypts Kubernetes Secret resources stored in etcd. It does NOT
 * cover GKE node boot disks (separate per-pool CMEK), Cloud SQL data, or
 * Persistent Volumes — those use independent CMEK configurations.
 *
 * Rotation: 90 days, handled transparently by Cloud KMS. Older key versions
 * remain available for decryption of already-encrypted data, so rotation
 * does not break the cluster.
 *
 * Lifecycle warning: cluster-creation-time etcd CMEK is irreversible per GKE
 * documentation. Destroying this key would render the cluster's stored
 * Secrets unreadable. The CryptoKey resource is marked `protect: true` so
 * Pulumi refuses to destroy it without an explicit override.
 */
export class KmsComponent extends pulumi.ComponentResource {
	public readonly keyRing: gcp.kms.KeyRing
	public readonly cryptoKey: gcp.kms.CryptoKey
	/** Full resource name of the CryptoKey, suitable for cluster `databaseEncryption.keyName`. */
	public readonly keyName: pulumi.Output<string>

	constructor(
		name: string,
		args: KmsComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:KmsComponent', name, args, opts)

		const { project, region, environment } = args

		const apiService = new ApiService(project, environment)
		const enabledApis = apiService.enableApis(
			['cloudkms.googleapis.com'],
			this,
		)

		this.keyRing = new gcp.kms.KeyRing(
			'gke-cluster',
			{
				name: 'gke-cluster',
				project: project.projectId,
				location: region,
			},
			{ parent: this, dependsOn: enabledApis },
		)

		this.cryptoKey = new gcp.kms.CryptoKey(
			'gke-etcd-encryption',
			{
				name: 'gke-etcd-encryption',
				keyRing: this.keyRing.id,
				purpose: 'ENCRYPT_DECRYPT',
				rotationPeriod: '7776000s', // 90 days
				versionTemplate: {
					algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION',
					protectionLevel: 'SOFTWARE',
				},
			},
			{ parent: this, protect: true },
		)

		// Grant the GKE service agent permission to encrypt/decrypt with this
		// key. The agent (`service-<project-number>@container-engine-robot.
		// iam.gserviceaccount.com`) is automatically provisioned by GCP once
		// the Container API is enabled; the IAM binding works against its
		// well-known identity.
		new gcp.kms.CryptoKeyIAMMember(
			'gke-etcd-encryption-binding',
			{
				cryptoKeyId: this.cryptoKey.id,
				role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
				member: pulumi.interpolate`serviceAccount:service-${project.number}@container-engine-robot.iam.gserviceaccount.com`,
			},
			{ parent: this },
		)

		this.keyName = this.cryptoKey.id

		this.registerOutputs({
			keyRingId: this.keyRing.id,
			cryptoKeyId: this.cryptoKey.id,
		})
	}
}
