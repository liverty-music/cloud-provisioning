import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type * as zitadel from '@pulumiverse/zitadel'
import { MachineUserComponent } from './machine-user.js'

export interface BackendMachineKeyComponentArgs {
	/** Environment label, drives only naming/scoping. Dev currently keeps its
	 *  existing Zitadel-class-routed flow; this component is intentionally
	 *  prod-shaped (provider + admin org lookup + GSM bundle) so the prod
	 *  call site is a single expressive line and dev URNs remain untouched. */
	env: 'dev' | 'prod'

	/** GCP project that will own the `zitadel-machine-key-for-backend-app`
	 *  GSM Secret + IAM bindings. */
	gcpProject: pulumi.Input<string>

	/** Zitadel provider configured against the environment's self-hosted
	 *  Zitadel API (e.g., `https://auth.liverty-music.app` for prod) and
	 *  authenticated via the bootstrap-uploaded admin JWT (per design D3). */
	zitadelProvider: zitadel.Provider

	/** Org id where the backend MachineUser is created. For prod this is the
	 *  first-boot "admin" org id resolved via a `zitadel.getOrg` data source
	 *  (per design D2 — Pulumi does not create this org). */
	orgId: pulumi.Input<string>

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
 * Five Pulumi resources are produced:
 *   1. `zitadel.MachineUser` — `backend-app` principal (via inner MachineUserComponent)
 *   2. `zitadel.MachineKey` — JWT-profile key pair (via inner MachineUserComponent)
 *   3. `zitadel.OrgMember`  — ORG_USER_MANAGER role grant (via inner MachineUserComponent)
 *   4. `gcp.secretmanager.Secret`        — `zitadel-machine-key-for-backend-app` (this component)
 *   5. `gcp.secretmanager.SecretVersion` — JWT-profile JSON (this component)
 *   6. `gcp.secretmanager.SecretIamMember` — ESO accessor (this component)
 *   (Parent ComponentResource counts as one URN but not a separate GCP-side resource.)
 *
 * The org-admin JWT (`zitadel-machine-key-for-pulumi-admin`) is consumed only
 * by Pulumi's Zitadel provider at plan/apply time; it is NEVER mounted into a
 * Pod. The lower-privilege key this component produces is what the backend
 * Pod mounts via ESO at runtime — preserving the blast-radius separation
 * established in `prod-k8s-manifests` round-12.
 */
export class BackendMachineKeyComponent extends pulumi.ComponentResource {
	public readonly machineUser: MachineUserComponent
	public readonly secret: gcp.secretmanager.Secret
	public readonly secretVersion: gcp.secretmanager.SecretVersion
	public readonly secretAccessorBinding: gcp.secretmanager.SecretIamMember

	/** The JWT-profile JSON for authenticating as this machine user. Stored in
	 *  GSM via this component; exposed here for callers that want to test or
	 *  reference it programmatically. Never log directly. */
	public readonly keyDetails: pulumi.Output<string>

	constructor(
		name: string,
		args: BackendMachineKeyComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:BackendMachineKey', name, {}, opts)

		const { env, gcpProject, zitadelProvider, orgId } = args
		const esoServiceAccountEmail =
			args.esoServiceAccountEmail ??
			pulumi
				.output(gcpProject)
				.apply(
					(p) =>
						`serviceAccount:k8s-external-secrets@${p}.iam.gserviceaccount.com`,
				)

		this.machineUser = new MachineUserComponent(
			name,
			{ orgId, provider: zitadelProvider },
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
				secretData: this.machineUser.keyDetails,
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
			machineUser: this.machineUser,
			secret: this.secret,
			secretVersion: this.secretVersion,
			secretAccessorBinding: this.secretAccessorBinding,
			keyDetails: this.keyDetails,
		})
	}
}
