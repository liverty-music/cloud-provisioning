import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Region, RegionName } from '../region.js'
import { ApiService, type GoogleApis } from '../services/api.js'
import { IamService, Roles } from '../services/iam.js'

export interface SecretConfig {
	/** GCP Secret Manager secret name, e.g. 'lastfm-api-key'. */
	name: string
	/** The secret value to store. Pass as pulumi.secret() to ensure it is encrypted. */
	value: pulumi.Input<string>
}

export interface KubernetesComponentArgs {
	project: gcp.organizations.Project
	environment: 'dev' | 'staging' | 'prod'
	region: Region
	regionName: RegionName

	/**
	 * The network self link or ID where the subnet and cluster will be created.
	 */
	networkId: pulumi.Input<string>

	/**
	 * CIDR ranges for the subnet and cluster.
	 */
	subnetCidr: pulumi.Input<string>
	podsCidr: pulumi.Input<string>
	servicesCidr: pulumi.Input<string>
	masterCidr: string

	/**
	 * Cloud KMS CryptoKey resource name used for the GKE cluster's etcd
	 * Application-layer Secrets Encryption. When provided, the cluster is
	 * created with `databaseEncryption.state = ENCRYPTED`. Currently passed
	 * for prod only; dev does not enable etcd CMEK. Irreversible at cluster
	 * creation per GKE docs.
	 */
	etcdCmekKeyName?: pulumi.Input<string>

	/**
	 * The Artifact Registry repositories to grant pull access to.
	 */
	artifactRegistries: gcp.artifactregistry.Repository[]

	/**
	 * Runtime secrets to provision in GCP Secret Manager and grant access to the backend-app SA.
	 * Each entry creates a secret, a version (value from Pulumi config), and an IAM accessor binding.
	 */
	secrets?: SecretConfig[]

	/**
	 * Secrets provisioned in GCP Secret Manager with ESO-only access (no backend-app SA binding).
	 * Used for secrets consumed by non-backend workloads (e.g., ArgoCD) via ExternalSecret.
	 */
	esoOnlySecrets?: SecretConfig[]
}

export class KubernetesComponent extends pulumi.ComponentResource {
	public readonly subnet: gcp.compute.Subnetwork
	public readonly nodeServiceAccountEmail: pulumi.Output<string>
	public readonly backendAppServiceAccountEmail: pulumi.Output<string>
	public readonly otelCollectorServiceAccountEmail: pulumi.Output<string>
	public readonly zitadelServiceAccountEmail: pulumi.Output<string>
	/** ESO controller's GCP SA email — exposed so callers can grant per-secret accessor bindings. */
	public readonly esoServiceAccountEmail: pulumi.Output<string>

	constructor(
		name: string,
		args: KubernetesComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:KubernetesComponent', name, args, opts)

		const {
			project,
			environment,
			region,
			regionName,
			networkId,
			subnetCidr,
			podsCidr,
			servicesCidr,
			masterCidr,
			etcdCmekKeyName,
			artifactRegistries,
			secrets = [],
			esoOnlySecrets = [],
		} = args

		const apiService = new ApiService(project)
		// `places.googleapis.com` is dev-only (gated by gcp-cost-guardrails:
		// dev has a per-day quota override for venue enrichment; prod does
		// not use the Places API directly).
		const apisToEnable: GoogleApis[] = ['container.googleapis.com']
		if (environment === 'dev') {
			apisToEnable.push('places.googleapis.com')
		}
		const enabledApis = apiService.enableApis(apisToEnable, this)
		const allSecrets = [...secrets, ...esoOnlySecrets]
		const enabledSecretManagerApi =
			allSecrets.length > 0
				? apiService.enableApis(['secretmanager.googleapis.com'], this)
				: []

		// 1. Dedicated Service Account for GKE Nodes
		const iamSvc = new IamService(project)
		const gkeNodeSa = iamSvc.createServiceAccount(
			`gke-node`,
			`gke-node`,
			`GKE Node Service Account`,
			'Service Account for GKE Node Pool',
			this,
		)
		this.nodeServiceAccountEmail = gkeNodeSa.email

		// Grant standard GKE node roles
		iamSvc.bindProjectRoles(
			[Roles.Logging.LogWriter, Roles.Monitoring.MetricWriter],
			`gke-node`,
			gkeNodeSa.email,
			this,
		)

		// Grant permission to pull from Artifact Registries
		// Registry order: [backend, frontend]
		const registryNames = ['backend', 'frontend']
		for (const [index, registry] of artifactRegistries.entries()) {
			iamSvc.bindArtifactRegistryReader(
				`${registryNames[index]}-gke-node`,
				gkeNodeSa.email,
				registry,
				region,
				this,
			)
		}

		// 2. Application Service Account (backend-app)
		const backendApp = 'backend-app'
		const namespace = 'backend'
		const backendAppSa = iamSvc.createServiceAccount(
			`liverty-music-${backendApp}`,
			backendApp,
			'Liverty Music Backend Application Service Account',
			'Service account for backend application',
			this,
		)
		this.backendAppServiceAccountEmail = backendAppSa.email

		// Grant permission to pull from Artifact Registries
		// Registry order: [backend, frontend]
		for (const [index, registry] of artifactRegistries.entries()) {
			iamSvc.bindArtifactRegistryReader(
				`${registryNames[index]}-app`,
				backendAppSa.email,
				registry,
				region,
				this,
			)
		}
		iamSvc.bindProjectRoles(
			[
				Roles.Logging.LogWriter,
				Roles.Monitoring.MetricWriter,
				Roles.CloudTrace.Agent,
				Roles.CloudSql.InstanceUser,
				Roles.AiPlatform.User,
				Roles.ServiceUsage.ServiceUsageConsumer,
			],
			backendApp,
			backendAppSa.email,
			this,
		)

		// Bind Kubernetes Service Account to Workload Identity
		iamSvc.bindKubernetesSaUser(backendApp, backendAppSa, namespace, this)

		// External Secrets Operator Service Account
		// Uses pod identity (ADC): ESO controller pod authenticates directly via its own GCP SA.
		// This avoids sharing the backend-app SA with the cluster-wide ESO operator.
		//
		// esoK8sSaName: the K8s SA name created by the ESO Helm chart — used in the WIF
		// principal URL (ns/{esoNamespace}/sa/{esoK8sSaName}). Must not change.
		const esoK8sSaName = 'external-secrets'
		const esoNamespace = 'external-secrets'
		const esoSa = iamSvc.createServiceAccount(
			'k8s-external-secrets',
			'k8s-external-secrets',
			'External Secrets Operator Service Account',
			'Service account for ESO controller to read GCP Secret Manager secrets',
			this,
		)
		// Allow K8s SA external-secrets/external-secrets to impersonate this GCP SA.
		// NOTE: bindKubernetesSaUser uses `name` as both the Pulumi logical resource name
		// prefix AND the K8s SA name embedded in the WIF principal URL
		// (ns/{namespace}/sa/{name}). Therefore esoK8sSaName MUST match the actual K8s SA
		// name created by the ESO Helm chart ('external-secrets') and must not be changed
		// to match the GCP SA account ID ('k8s-external-secrets').
		// Resulting Pulumi resource: external-secrets-k8s-sa-wif-user
		iamSvc.bindKubernetesSaUser(esoK8sSaName, esoSa, esoNamespace, this)

		// 3. GCP Secret Manager secrets for backend-app
		// Both backend-app and ESO SAs receive per-secret SecretAccessor bindings so that
		// neither SA has broader project-level access than strictly required.
		for (const secret of secrets) {
			const secretResource = new gcp.secretmanager.Secret(
				secret.name,
				{
					secretId: secret.name,
					project: project.projectId,
					replication: { auto: {} },
				},
				{ parent: this, dependsOn: enabledSecretManagerApi },
			)
			new gcp.secretmanager.SecretVersion(
				`${secret.name}-version`,
				{
					secret: secretResource.id,
					secretData: secret.value,
				},
				{ parent: this },
			)
			new gcp.secretmanager.SecretIamMember(
				`${secret.name}-backend-app-accessor`,
				{
					secretId: secretResource.secretId,
					project: project.projectId,
					role: Roles.SecretManager.SecretAccessor,
					member: pulumi.interpolate`serviceAccount:${backendAppSa.email}`,
				},
				{ parent: this },
			)
			// ESO per-secret binding — avoids project-level secretAccessor
			new gcp.secretmanager.SecretIamMember(
				`${secret.name}-eso-accessor`,
				{
					secretId: secretResource.secretId,
					project: project.projectId,
					role: Roles.SecretManager.SecretAccessor,
					member: pulumi.interpolate`serviceAccount:${esoSa.email}`,
				},
				{ parent: this },
			)
		}

		// 3b. GCP Secret Manager secrets with ESO-only access
		// These secrets are consumed by non-backend workloads (e.g., ArgoCD) via ExternalSecret.
		// Only the ESO SA receives SecretAccessor — no backend-app SA binding.
		for (const secret of esoOnlySecrets) {
			const secretResource = new gcp.secretmanager.Secret(
				secret.name,
				{
					secretId: secret.name,
					project: project.projectId,
					replication: { auto: {} },
				},
				{ parent: this, dependsOn: enabledSecretManagerApi },
			)
			new gcp.secretmanager.SecretVersion(
				`${secret.name}-version`,
				{
					secret: secretResource.id,
					secretData: secret.value,
				},
				{ parent: this },
			)
			new gcp.secretmanager.SecretIamMember(
				`${secret.name}-eso-accessor`,
				{
					secretId: secretResource.secretId,
					project: project.projectId,
					role: Roles.SecretManager.SecretAccessor,
					member: pulumi.interpolate`serviceAccount:${esoSa.email}`,
				},
				{ parent: this },
			)
		}

		// ArgoCD Image Updater Service Account
		const imageUpdaterK8sSaName = 'argocd-image-updater'
		const imageUpdaterNamespace = 'argocd'
		const imageUpdaterSa = iamSvc.createServiceAccount(
			'k8s-argocd-image-updater',
			'argocd-image-updater',
			'ArgoCD Image Updater Service Account',
			'Service account for ArgoCD Image Updater to read container images from GAR',
			this,
		)
		for (const [index, registry] of artifactRegistries.entries()) {
			iamSvc.bindArtifactRegistryReader(
				`${registryNames[index]}-image-updater`,
				imageUpdaterSa.email,
				registry,
				region,
				this,
			)
		}
		iamSvc.bindKubernetesSaUser(
			imageUpdaterK8sSaName,
			imageUpdaterSa,
			imageUpdaterNamespace,
			this,
		)

		// OTel Collector Service Account
		const otelCollectorName = 'otel-collector'
		const otelCollectorNamespace = 'otel-collector'
		const otelCollectorSa = iamSvc.createServiceAccount(
			otelCollectorName,
			otelCollectorName,
			'OTel Collector Service Account',
			'Service account for OpenTelemetry Collector to export traces to Cloud Trace and metrics to Cloud Monitoring',
			this,
		)
		this.otelCollectorServiceAccountEmail = otelCollectorSa.email
		// `MetricWriter` covers `monitoring.metricDescriptors.create` and
		// `monitoring.timeSeries.create`, both required by the
		// `googlecloud` exporter when pushing custom metrics from OTLP.
		// Without this role the exporter logs `PermissionDenied desc =
		// Permission monitoring.metricDescriptors.create denied` for every
		// new metric Zitadel/backend pushes (verified empirically during
		// `zitadel-observability` PR-1a deploy).
		iamSvc.bindProjectRoles(
			[Roles.CloudTrace.Agent, Roles.Monitoring.MetricWriter],
			otelCollectorName,
			otelCollectorSa.email,
			this,
		)
		iamSvc.bindKubernetesSaUser(
			otelCollectorName,
			otelCollectorSa,
			otelCollectorNamespace,
			this,
		)

		// Self-hosted Zitadel Service Account.
		// Used by the Zitadel API Pod and its Cloud SQL Auth Proxy sidecar to:
		//   - Authenticate to Cloud SQL as an IAM SQL user (cloudsql.instanceUser + client)
		//   - Write the bootstrap admin SA key to GSM on first run (secretVersionAdder
		//     binding is applied at the per-secret level in the Zitadel component)
		//
		// Naming mirrors the `backend-app` pattern (K8s SA name == GCP SA id ==
		// SQL User resource name). The `k8s-` prefix used for `k8s-external-secrets`
		// and `k8s-argocd-image-updater` is *not* applied here because our
		// manifest owns the K8s SA name (`zitadel`), so there is no naming
		// collision with a Helm-chart-imposed name that the prefix would resolve.
		const zitadelApp = 'zitadel'
		const zitadelNamespace = 'zitadel'
		const zitadelSa = iamSvc.createServiceAccount(
			zitadelApp,
			zitadelApp,
			'Zitadel Service Account',
			'Service account for self-hosted Zitadel (DB IAM auth + bootstrap)',
			this,
		)
		this.zitadelServiceAccountEmail = zitadelSa.email
		iamSvc.bindProjectRoles(
			[Roles.CloudSql.Client, Roles.CloudSql.InstanceUser],
			zitadelApp,
			zitadelSa.email,
			this,
		)
		iamSvc.bindKubernetesSaUser(
			zitadelApp,
			zitadelSa,
			zitadelNamespace,
			this,
		)

		// Expose ESO SA email so callers (Zitadel secrets component) can attach
		// per-secret accessor bindings without re-creating the ESO SA.
		this.esoServiceAccountEmail = esoSa.email

		// 5. Dedicated Subnet for GKE
		this.subnet = new gcp.compute.Subnetwork(
			`cluster-subnet-${regionName}`,
			{
				name: `cluster-subnet-${regionName}`,
				network: networkId,
				region: region,
				ipCidrRange: subnetCidr,
				privateIpGoogleAccess: true,
				secondaryIpRanges: [
					{
						rangeName: 'pods-range',
						ipCidrRange: podsCidr,
					},
					{
						rangeName: 'services-range',
						ipCidrRange: servicesCidr,
					},
				],
			},
			{ parent: this },
		)

		if (environment === 'prod') {
			// 6. GKE Autopilot Cluster (regional) — prod.
			//
			// Migrated from Standard regional per the migrate-prod-to-autopilot
			// OpenSpec change. Rationale: post-dev-retirement, the $74.40/mo GKE
			// free-tier credit covers the Autopilot management fee (regional
			// Standard is not free-tier-eligible), dropping the prod management
			// fee from $72/mo to $0. Net savings $50-70/mo even after Autopilot's
			// unavoidable GMP managed collection.
			//
			// GMP / monitoring cost control on Autopilot ≥ 1.25 — the
			// `monitoringConfig` block below pushes ingestion as close to
			// disabled as the platform allows:
			//
			//   • `enableComponents: ['SYSTEM_COMPONENTS']` — drops the 10
			//     optional GKE components Autopilot enables by default
			//     (STORAGE, HPA, POD, DAEMONSET, DEPLOYMENT, STATEFULSET,
			//     CADVISOR, KUBELET, DCGM, JOBSET). SYSTEM_COMPONENTS is the
			//     mandatory floor per
			//     [configure-metrics docs](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-metrics):
			//     *"For GKE Autopilot clusters, you cannot disable the
			//     collection of system metrics."*
			//   • `managedPrometheus.enabled: true` — mandatory on Autopilot
			//     ≥ 1.25 per
			//     [GMP setup-managed docs](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/setup-managed):
			//     *"You can't turn off managed collection in GKE Autopilot
			//     clusters running GKE version 1.25 or greater."*
			//   • `advancedDatapathObservabilityConfig.enableMetrics: false`
			//     — disables Cilium/Hubble per-node network-flow metrics,
			//     the biggest variable cost driver as nodes scale up.
			//   • `autoMonitoringConfig.scope` is left unset — Autopilot's
			//     default per
			//     [GMP auto-monitoring docs](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/auto-monitoring)
			//     is OFF for both Autopilot and Standard, so unset == NONE
			//     and no application Pods are auto-discovered.
			//
			// The unavoidable cost floor is the GKE-managed system pipeline:
			// the `kube-state-metrics` and `gke-managed-dcgm-exporter` CRs
			// in `gke-managed-cim` / `gke-gmp-system` namespaces (both
			// addon-managed with `addonmanager.kubernetes.io/mode: Reconcile`,
			// so user edits are reverted). At idle (zero workloads → zero
			// nodes) the kube-state-metrics Pod stays Pending and the
			// empirical GMP cost is ~$0. When workloads land, per-node
			// kubelet/cAdvisor + kube-state-metrics emission begins.
			//
			// **Pulumi serializer gotcha (resolved)**: an earlier draft set
			// `monitoringConfig` with ONLY `managedPrometheus` — Pulumi/TF
			// serialized the missing `enableComponents` as `[]`, which
			// Autopilot rejected with `Error 400: Autopilot clusters must
			// have monitoring enabled`. Setting `enableComponents` explicitly
			// avoids the trap (PR #250 hotfix, then this PR's tightening).
			//
			// User workload metrics become opt-in via per-namespace
			// `PodMonitoring` CRDs in the `prod-k8s-manifests` follow-up.
			//
			// Irreversible decisions preserved at creation:
			//   • Autopilot mode — cannot be flipped to Standard in-place.
			//   • Regional location (asia-northeast2) — three-zone resilience.
			//   • etcd CMEK (databaseEncryption.state: ENCRYPTED) — irreversible
			//     at cluster level; KMS key provisioned by KmsComponent and
			//     reused as-is from the Standard cluster era.
			//
			// Autopilot-managed defaults (not user-configurable knobs):
			//   • Dataplane V2 — Autopilot default, no `datapathProvider` needed.
			//   • Shielded GKE Nodes — enforced automatically.
			//   • Node provisioning, machine types, boot disks — managed by
			//     Autopilot. Spot scheduling is per-Pod via the
			//     `cloud.google.com/gke-spot: "true"` nodeSelector.
			//
			// See also docs/PROD_BOOTSTRAP_DECISIONS.md and
			// docs/GKE_CLUSTER_MODE_DECISION.md.
			if (!etcdCmekKeyName) {
				throw new Error(
					'etcdCmekKeyName is required for the prod cluster. Provision a KmsComponent and pass its keyName.',
				)
			}
			const cluster = new gcp.container.Cluster(
				`autopilot-cluster-${regionName}`,
				{
					name: `autopilot-cluster-${regionName}`,
					// Regional (3-zone). Irreversible after creation.
					location: region,
					enableAutopilot: true,
					deletionProtection: true,
					network: networkId,
					subnetwork: this.subnet.id,

					// etcd Application-layer Secrets Encryption using a customer-
					// managed Cloud KMS key. Encrypts Kubernetes Secret resources
					// stored in etcd. Irreversible at cluster creation.
					databaseEncryption: {
						state: 'ENCRYPTED',
						keyName: etcdCmekKeyName,
					},

					ipAllocationPolicy: {
						clusterSecondaryRangeName: 'pods-range',
						servicesSecondaryRangeName: 'services-range',
					},

					// Autopilot auto-provisioning uses this SA for node-level
					// logging/monitoring; workloads still bind to their own GCP
					// SAs via Workload Identity (which Autopilot enforces).
					clusterAutoscaling: {
						autoProvisioningDefaults: {
							serviceAccount: gkeNodeSa.email,
						},
					},

					workloadIdentityConfig: {
						workloadPool: pulumi.interpolate`${project.projectId}.svc.id.goog`,
					},

					releaseChannel: {
						channel: 'REGULAR',
					},

					costManagementConfig: {
						enabled: true,
					},

					gatewayApiConfig: {
						channel: 'CHANNEL_STANDARD',
					},

					// Minimum monitoring config — see leading block comment
					// for rationale + GCP doc citations.
					monitoringConfig: {
						enableComponents: ['SYSTEM_COMPONENTS'],
						managedPrometheus: {
							enabled: true,
						},
						advancedDatapathObservabilityConfig: {
							enableMetrics: false,
							enableRelay: false,
						},
					},
				},
				{ parent: this, dependsOn: enabledApis },
			)

			this.registerOutputs({
				clusterName: cluster.name,
				clusterEndpoint: cluster.endpoint,
				subnetId: this.subnet.id,
				nodeServiceAccountEmail: this.nodeServiceAccountEmail,
				backendAppServiceAccountEmail:
					this.backendAppServiceAccountEmail,
				otelCollectorServiceAccountEmail:
					this.otelCollectorServiceAccountEmail,
				zitadelServiceAccountEmail: this.zitadelServiceAccountEmail,
				esoServiceAccountEmail: this.esoServiceAccountEmail,
			})
			return
		}

		if (environment === 'dev') {
			// 6. GKE Standard Cluster (zonal, Spot node pool) — dev only.
			//
			// Mode rationale: Standard (not Autopilot) gives node-level control needed
			// for aggressive dev cost optimization — custom node pool sizing, e2-medium
			// Spot, 30 GB pd-standard boot disks, kube-dns autoscaler overrides, GMP
			// disabled. Autopilot would block most of these.
			//
			// IMPORTANT: the $0.10/hr cluster management fee applies to BOTH Autopilot
			// and Standard equally — choosing Standard does NOT eliminate it. The GKE
			// free tier ($74.40/month per billing account ≈ one cluster's fee) covers
			// either a zonal Standard cluster OR an Autopilot cluster. So the dev
			// "Kubernetes Engine" line ≈ ¥0 comes from the free-tier credit, not from
			// Standard mode itself. See docs/GKE_CLUSTER_MODE_DECISION.md.
			//
			// Public nodes (enablePrivateNodes: false) avoid the ~¥5,292/month Cloud
			// NAT fixed cost. This is acceptable for DEV ONLY — prod must use private
			// nodes for security regardless of cost.
			const cluster = new gcp.container.Cluster(
				`standard-cluster-${regionName}`,
				{
					name: `standard-cluster-${regionName}`,
					location: `${region}-a`, // Zonal — eligible for $74.40/mo free-tier credit per billing account.
					deletionProtection: false,
					network: networkId,
					subnetwork: this.subnet.id,
					// Remove default node pool immediately; managed via separate NodePool resource
					removeDefaultNodePool: true,
					initialNodeCount: 1,

					// Networking
					ipAllocationPolicy: {
						clusterSecondaryRangeName: 'pods-range',
						servicesSecondaryRangeName: 'services-range',
					},

					// Public nodes — eliminates Cloud NAT requirement
					privateClusterConfig: {
						enablePrivateNodes: false,
						enablePrivateEndpoint: false,
					},

					// Workload Identity
					workloadIdentityConfig: {
						workloadPool: pulumi.interpolate`${project.projectId}.svc.id.goog`,
					},

					// Release Channel
					releaseChannel: {
						channel: 'REGULAR',
					},

					// Cost Management
					costManagementConfig: {
						enabled: true,
					},

					// Gateway API (required for GKE Gateway resources)
					gatewayApiConfig: {
						channel: 'CHANNEL_STANDARD',
					},

					// Logging: include `WORKLOADS` so log-based AlertPolicies
					// (e.g., `alert-error-log-server`, `alert-poison-queue-message`,
					// `alert-atlas-migration-failure`, `alert-backend-jwt-zitadel-errors`)
					// can actually fire — they read from Cloud Logging, which
					// only ingests workload pod stdout when this component is
					// enabled.
					//
					// Monitoring: stays system-only. We have no metric-based
					// workload alerts today, so enabling GMP / workload
					// monitoring would add Cloud Monitoring cost without a
					// current consumer. Revisit if a metric-based alert is
					// added to the project.
					loggingConfig: {
						enableComponents: ['SYSTEM_COMPONENTS', 'WORKLOADS'],
					},
					monitoringConfig: {
						enableComponents: ['SYSTEM_COMPONENTS'],
						managedPrometheus: {
							enabled: false,
						},
					},
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// 7. Spot Node Pool (e2-standard-2)
			new gcp.container.NodePool(
				`spot-pool-${regionName}`,
				{
					name: `spot-pool-${regionName}`,
					cluster: cluster.id,
					location: `${region}-a`,

					autoscaling: {
						minNodeCount: 1,
						// Raised 2 → 3 so the newly-added Zitadel API + Login
						// Deployments (each `replicas: 2` with hostname
						// anti-affinity) can schedule alongside existing
						// backend/ArgoCD/ESO/etc. workloads that already consume
						// ~96% of the previous 2-node CPU budget. Keeping
						// design D8's `required` anti-affinity (spot death must
						// not take both pods) means dev needs ≥3 spot nodes
						// to host api×2 + login×2 on distinct hostnames.
						maxNodeCount: 3,
					},

					nodeConfig: {
						machineType: 'e2-medium',
						spot: true,
						// 30 GB pd-standard. The GKE default is 100 GB pd-balanced,
						// which dominated dev Compute Engine cost (~45% of the SKU
						// at 3 nodes). E2 does not support any Hyperdisk variant
						// (per cloud.google.com/compute/docs/disks/hyperdisks), so
						// pd-standard is the cheapest available type for this
						// machine series. 30 GB is GKE's recommended minimum and
						// comfortably fits the cluster's image cache (Zitadel +
						// cloud-sql-proxy + backend + frontend + ArgoCD + KEDA +
						// Atlas + ESO + Reloader + OTel) without triggering
						// DiskPressure evictions.
						diskSizeGb: 30,
						diskType: 'pd-standard',
						serviceAccount: gkeNodeSa.email,
						oauthScopes: [
							'https://www.googleapis.com/auth/cloud-platform',
						],
						workloadMetadataConfig: {
							mode: 'GKE_METADATA',
						},
						// Autopilot enforces Shielded GKE Nodes automatically.
						// Standard clusters do not — set explicitly to maintain the same
						// security posture, especially critical for public nodes.
						shieldedInstanceConfig: {
							enableSecureBoot: true,
							enableIntegrityMonitoring: true,
						},
						labels: {
							'cloud.google.com/gke-spot': 'true',
						},
					},

					management: {
						autoRepair: true,
						autoUpgrade: true,
					},
				},
				{ parent: this, dependsOn: [cluster] },
			)

			this.registerOutputs({
				clusterName: cluster.name,
				clusterEndpoint: cluster.endpoint,
				subnetId: this.subnet.id,
				nodeServiceAccountEmail: this.nodeServiceAccountEmail,
				backendAppServiceAccountEmail:
					this.backendAppServiceAccountEmail,
				otelCollectorServiceAccountEmail:
					this.otelCollectorServiceAccountEmail,
				zitadelServiceAccountEmail: this.zitadelServiceAccountEmail,
				esoServiceAccountEmail: this.esoServiceAccountEmail,
			})
			return
		}

		// 6. GKE Autopilot Cluster (staging)
		const cluster = new gcp.container.Cluster(
			`cluster-${regionName}`,
			{
				name: `cluster-${regionName}`,
				location: region,
				enableAutopilot: true,
				deletionProtection: true,
				network: networkId,
				subnetwork: this.subnet.id,
				datapathProvider: 'ADVANCED_DATAPATH',

				clusterAutoscaling: {
					autoProvisioningDefaults: {
						serviceAccount: gkeNodeSa.email,
					},
				},

				ipAllocationPolicy: {
					clusterSecondaryRangeName: 'pods-range',
					servicesSecondaryRangeName: 'services-range',
				},

				privateClusterConfig: {
					enablePrivateNodes: true,
					enablePrivateEndpoint: false,
					masterIpv4CidrBlock: masterCidr,
				},

				releaseChannel: {
					channel: 'REGULAR',
				},

				costManagementConfig: {
					enabled: true,
				},
			},
			{ parent: this, dependsOn: enabledApis },
		)

		this.registerOutputs({
			clusterName: cluster.name,
			clusterEndpoint: cluster.endpoint,
			subnetId: this.subnet.id,
			nodeServiceAccountEmail: this.nodeServiceAccountEmail,
			backendAppServiceAccountEmail: this.backendAppServiceAccountEmail,
			otelCollectorServiceAccountEmail:
				this.otelCollectorServiceAccountEmail,
			zitadelServiceAccountEmail: this.zitadelServiceAccountEmail,
			esoServiceAccountEmail: this.esoServiceAccountEmail,
		})
	}
}
