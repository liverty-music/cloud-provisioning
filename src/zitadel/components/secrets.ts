import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as random from '@pulumi/random'
import * as tls from '@pulumi/tls'

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
 * - `zitadel-system-api-key` / `zitadel-system-api-pub`: RSA-2048 key pair
 *   for the `pulumi-system` Zitadel System API user (declared via the API
 *   container's `ZITADEL_SYSTEMAPIUSERS` env). The private key signs JWTs
 *   from the `ZitadelInstanceCustomDomain` Pulumi Dynamic Resource; the
 *   public key is synced into the cluster via ESO and projected into the
 *   `zitadel-api` Pod for JWT verification. Introduced by the
 *   `route-login-v2-via-internal-zitadel-api` change so the Login UI's
 *   API calls can target a cluster-internal hostname (registered via
 *   `instance.v2.AddCustomDomain`, which requires `SYSTEM_OWNER`).
 */
export class SecretsComponent extends pulumi.ComponentResource {
	public readonly masterkeySecret: gcp.secretmanager.Secret
	/** GSM secret holding the `pulumi-admin` MachineUser's JWT-profile JSON.
	 *  Follows the platform-wide convention `zitadel-machine-key-for-<principal>`. */
	public readonly pulumiAdminMachineKeySecret: gcp.secretmanager.Secret

	/** RSA-2048 key pair for the `pulumi-system` System API user. Pulumi
	 *  state persists the generated key, so re-applies are idempotent. */
	public readonly systemApiKeyPair: tls.PrivateKey
	/** PEM-encoded RSA private key. `[secret]` in state and preview. */
	public readonly systemApiPrivateKeyPem: pulumi.Output<string>
	/** PEM-encoded RSA public key. Synced into the cluster via ESO. */
	public readonly systemApiPublicKeyPem: pulumi.Output<string>
	/** GSM secret holding the System User RSA private key. PreservedTier. */
	public readonly systemApiPrivateSecret: gcp.secretmanager.Secret
	/** The SecretVersion to depend on so the Dynamic Resource only runs
	 *  after the version is materialised in GSM. */
	public readonly systemApiPrivateSecretVersion: gcp.secretmanager.SecretVersion
	/** GSM secret holding the System User RSA public key. ESO reads this. */
	public readonly systemApiPublicSecret: gcp.secretmanager.Secret

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

		// System API user (`pulumi-system`) key pair. Drives the
		// `ZitadelInstanceCustomDomain` Pulumi Dynamic Resource — the only
		// path to register a cluster-internal hostname like
		// `zitadel-api.zitadel.svc.cluster.local` as an InstanceCustomDomain,
		// because `instance.v2.AddCustomDomain` requires `system.domain.write`
		// (SYSTEM_OWNER) which `IAM_OWNER` (`pulumi-admin`) cannot satisfy.
		// `tls.PrivateKey` is chosen over Node `crypto.generateKeyPairSync`
		// because Pulumi state persists the generated key, making re-applies
		// idempotent — `crypto.generateKeyPairSync` is non-deterministic and
		// would churn the SecretVersion on every `pulumi up`.
		// `protect: true` defends the `tls.PrivateKey` resource itself
		// against a `pulumi destroy` cascade. Losing the key pair forces
		// the InstanceCustomDomain to be re-registered against a freshly
		// minted public key — recoverable but operationally painful, and
		// the only way to recover currently goes through Zitadel Console
		// (the System API needs a valid System User to authenticate at
		// all). See `docs/runbooks/pulumi-state-recovery.md` §13.4 for
		// prior incident context.
		this.systemApiKeyPair = new tls.PrivateKey(
			'zitadel-system-api-key',
			{
				algorithm: 'RSA',
				rsaBits: 2048,
			},
			{ parent: this, protect: true },
		)
		// `tls.PrivateKey.privateKeyPem` is already marked secret by the
		// provider; `pulumi.secret(...)` here is belt-and-suspenders so the
		// output stays `[secret]` even if it traverses a non-secret-aware
		// transformation downstream.
		this.systemApiPrivateKeyPem = pulumi.secret(
			this.systemApiKeyPair.privateKeyPem,
		)
		this.systemApiPublicKeyPem = this.systemApiKeyPair.publicKeyPem

		// PreservedTier: the secret container + version survive a
		// `workloadEnabled=false` shutdown cycle so the same key continues
		// to validate against any already-registered InstanceCustomDomain
		// after restart.
		// `protect: true` on every System-API secret resource (container
		// + version, private + public). If GSM loses either secret the
		// recovery path is severely degraded: the private key cannot be
		// regenerated to match Zitadel's previously-loaded public key,
		// and a stale public-key K8s Secret (from ESO holding a cached
		// version after the GSM source is deleted) is invisible until
		// the next refresh. Both errors put the System User into a state
		// only recoverable by Zitadel Console reconfiguration.
		this.systemApiPrivateSecret = new gcp.secretmanager.Secret(
			'zitadel-system-api-key',
			{
				secretId: 'zitadel-system-api-key',
				project: project.projectId,
				replication: { auto: {} },
			},
			{ parent: this, protect: true },
		)

		this.systemApiPrivateSecretVersion =
			new gcp.secretmanager.SecretVersion(
				'zitadel-system-api-key-version',
				{
					secret: this.systemApiPrivateSecret.id,
					secretData: this.systemApiPrivateKeyPem,
				},
				{ parent: this, protect: true },
			)

		// Public key has its own GSM Secret so ESO can sync it into the
		// cluster without touching the private half. Storing both in GSM
		// (rather than reconstructing the public from the private at apply
		// time) keeps the rotation story symmetric — `tls.PrivateKey`
		// regeneration updates both versions atomically.
		this.systemApiPublicSecret = new gcp.secretmanager.Secret(
			'zitadel-system-api-pub',
			{
				secretId: 'zitadel-system-api-pub',
				project: project.projectId,
				replication: { auto: {} },
			},
			{ parent: this, protect: true },
		)

		new gcp.secretmanager.SecretVersion(
			'zitadel-system-api-pub-version',
			{
				secret: this.systemApiPublicSecret.id,
				secretData: this.systemApiPublicKeyPem,
			},
			{ parent: this, protect: true },
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

			// ESO read access on the System API **public** key only. The
			// private key never enters the cluster — it stays in GSM and is
			// only read by Pulumi at preview/up time to drive the
			// `ZitadelInstanceCustomDomain` Dynamic Resource's JWT signing.
			new gcp.secretmanager.SecretIamMember(
				'zitadel-system-api-pub-eso-accessor',
				{
					secretId: this.systemApiPublicSecret.secretId,
					project: project.projectId,
					role: 'roles/secretmanager.secretAccessor',
					member: pulumi.interpolate`serviceAccount:${workloadSAs.esoEmail}`,
				},
				{ parent: this },
			)
		}

		this.registerOutputs({
			masterkeySecretId: this.masterkeySecret.secretId,
			pulumiAdminMachineKeySecretId:
				this.pulumiAdminMachineKeySecret.secretId,
			systemApiPrivateSecretId: this.systemApiPrivateSecret.secretId,
			systemApiPublicSecretId: this.systemApiPublicSecret.secretId,
		})
	}
}
