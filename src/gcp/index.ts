import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { CloudflareConfig } from '../cloudflare/config.js'
import type { Environment } from '../config.js'
import { KmsComponent } from './components/kms.js'
import { KubernetesComponent } from './components/kubernetes.js'
import { MonitoringComponent } from './components/monitoring.js'
// import { ConcertDataStore } from './components/concert-data-store.js'
import {
	NetworkComponent,
	type PostmarkDnsConfig,
} from './components/network.js'
import { PostgresComponent } from './components/postgres.js'
import {
	type BlockchainConfig,
	type GcpConfig,
	ProjectComponent,
} from './components/project.js'
import { WorkloadIdentityComponent } from './components/workload-identity.js'
import { ZitadelMonitoringComponent } from './components/zitadel-monitoring.js'
import { RegionNames, Regions } from './region.js'

export interface GcpArgs {
	brandId: string
	displayName: string
	environment: Environment
	gcpConfig: GcpConfig
	lastFmApiKey?: pulumi.Output<string>
	fanartTvApiKey?: pulumi.Output<string>
	blockchainConfig?: BlockchainConfig
	cloudflareConfig: CloudflareConfig
	postmarkConfig: PostmarkDnsConfig
	/** Zitadel machine key JWT profile JSON. Stored in Secret Manager for backend use. */
	zitadelMachineKey?: pulumi.Output<string>
	/** Personal Access Token for the zitadel-login (Login V2 UI) container.
	 *  Stored in Secret Manager and mounted into the zitadel-login pod via
	 *  ExternalSecret as a file referenced by `ZITADEL_SERVICE_USER_TOKEN_FILE`. */
	zitadelLoginPat?: pulumi.Output<string>
	/** Gate for the workload tier (GKE / Cloud SQL / monitoring / GSM
	 *  Zitadel bootstrap secrets). When false (dev shutdown mode), these
	 *  resources are not provisioned. See
	 *  docs/runbooks/dev-shutdown-restart.md. */
	workloadEnabled: boolean
}

export const NetworkConfig = {
	Osaka: {
		// Primary range for GKE Nodes + PSC Endpoints
		subnetCidr: '10.10.0.0/20',
		// Secondary ranges for GKE
		podsCidr: '10.20.0.0/16',
		servicesCidr: '10.30.0.0/20',
		// GKE Control Plane CIDR
		masterCidr: '172.16.0.0/28',
		// Target IP for Cloud SQL PSC Endpoint
		postgresPscIp: '10.10.10.10',
	},
} as const

/**
 * Gcp orchestrates all GCP resources.
 * It is a plain class (not a ComponentResource) to keep the resource URNs flat.
 */
export class Gcp {
	public readonly folder:
		| gcp.organizations.Folder
		| pulumi.Output<gcp.organizations.Folder>
	public readonly project: gcp.organizations.Project
	public readonly projectId: pulumi.Output<string>
	public readonly region: string = Regions.Osaka
	public readonly githubActionsSAEmail: pulumi.Output<string>
	public readonly githubWorkloadIdentityProvider: pulumi.Output<string>
	/** Workload-tier resources — all defined together when
	 *  `workloadEnabled=true`, or the whole group is undefined when the
	 *  workload tier is destroyed (dev shutdown mode). Grouping the
	 *  cluster-tied outputs into one optional property lets call-sites
	 *  narrow the invariant with a single `if (gcp.workloadSAs)` check
	 *  instead of chaining truthiness on each `pulumi.Output<T>` (which
	 *  is always truthy at runtime, so chaining adds TS-only noise). */
	public readonly workloadSAs:
		| {
				/** Backend application GCP SA email. */
				backendAppEmail: pulumi.Output<string>
				/** Self-hosted Zitadel GCP SA email. */
				zitadelEmail: pulumi.Output<string>
				/** External Secrets Operator GCP SA email. */
				esoEmail: pulumi.Output<string>
				/** Cluster subnet ID — required for the PSC consumer
				 *  endpoint that lives inside this subnet. */
				subnetId: pulumi.Output<string>
		  }
		| undefined

	constructor(args: GcpArgs) {
		const {
			brandId,
			displayName,
			environment,
			gcpConfig,
			lastFmApiKey,
			fanartTvApiKey,
			blockchainConfig,
			cloudflareConfig,
			postmarkConfig,
			zitadelMachineKey,
			zitadelLoginPat,
			workloadEnabled,
		} = args

		const cloudSqlUsers = gcpConfig.cloudSqlUsers ?? []

		// 1. Project and Folders
		const projectBasis = new ProjectComponent({
			brandId,
			displayName,
			environment,
			gcpConfig,
		})
		this.folder = projectBasis.folder
		this.project = projectBasis.project
		this.projectId = this.project.projectId

		// 2. Identity Management (GSA + Workload Identity)
		// 3. Network (VPC, Subnets, NAT) - Osaka
		const network = new NetworkComponent('network', {
			region: Regions.Osaka,
			regionName: RegionNames.Osaka,
			project: this.project,
			environment,
			cloudflareConfig,
			postmarkConfig,
		})
		// 4. Concert Data Store (Vertex AI Search)
		// new ConcertDataStore({
		//   project: this.project,
		//   region: Regions.Osaka,
		// })

		// 4. Artifact Registry
		// immutableTags: non-dev only; dev stays mutable for ArgoCD Image Updater
		const dockerConfig =
			environment !== 'dev' ? { immutableTags: true } : undefined

		const backendArtifactRegistry = new gcp.artifactregistry.Repository(
			'github-backend-repository',
			{
				repositoryId: 'backend',
				location: Regions.Osaka,
				format: 'DOCKER',
				project: this.project.projectId,
				description: 'Docker repository for GitHub Backend Repository',
				dockerConfig,
			},
			{ parent: this.project },
		)

		const frontendArtifactRegistry = new gcp.artifactregistry.Repository(
			'github-frontend-repository',
			{
				repositoryId: 'frontend',
				location: this.region,
				format: 'DOCKER',
				project: this.project.projectId,
				description: 'Docker repository for GitHub Frontend Repository',
				dockerConfig,
			},
			{ parent: this.project },
		)

		// 4.1. Cross-project AR reader for the prod CI service account.
		//
		// Per OpenSpec changes `promote-prod-image-via-retag` (frontend,
		// archived) and `backend-symmetric-retag` (backend), the prod
		// release path stops rebuilding and instead retags the dev AR
		// digest into prod AR. The prod `github-actions` service account
		// needs READ on the dev project's `frontend` and `backend` AR
		// repos to resolve the digest. Scope is intentionally minimal:
		// per-repository READ only, exactly one direction
		// (prod CI → dev AR). The cluster-SA cross-project prohibition
		// (see `prod-image-pipeline` spec) is untouched — CI SAs are
		// ephemeral Workflow-run identities, structurally distinct from
		// the persistent cluster identities the prohibition targets.
		//
		// Lives in the dev stack because the AR resources being granted on
		// live in the dev project. The prod SA email is constructed by
		// mirroring `WorkloadIdentityComponent`'s naming convention:
		// SA short name `github-actions` (literal in workload-identity.ts)
		// + project ID `${brandId}-prod` (the codebase-wide
		// `${brandId}-${environment}` pattern; see project.ts). If the
		// SA short name OR the project-ID pattern ever changes, the
		// derivation here MUST be updated in lock-step.
		//
		// A pulumi.StackReference to the prod stack's exported
		// githubActionsSAEmail would decouple this, but is heavier
		// machinery (cross-stack dependency, additional output to maintain)
		// for what is functionally a single static value derivable from
		// `brandId` already in scope.
		//
		// The frontend and backend grants are declared side-by-side
		// (rather than collapsed into a loop) because Pulumi's
		// `RepositoryIamMember` is one-resource-per-binding and the
		// two AR repos are distinct named resources; pairing the
		// declarations keeps code review and Pulumi state human-readable.
		if (environment === 'dev') {
			const PROD_PROJECT_ID = `${brandId}-prod`
			const PROD_CI_SA_EMAIL = `serviceAccount:github-actions@${PROD_PROJECT_ID}.iam.gserviceaccount.com`

			new gcp.artifactregistry.RepositoryIamMember(
				'prod-ci-frontend-ar-reader',
				{
					repository: frontendArtifactRegistry.name,
					location: this.region,
					project: this.project.projectId,
					role: 'roles/artifactregistry.reader',
					member: PROD_CI_SA_EMAIL,
				},
				// protect: true — the grant is on the prod CI critical
				// path. A `pulumi destroy --target` or operator slip
				// silently breaks every subsequent release. Removal
				// requires deliberate `pulumi state unprotect` first,
				// which is the blast-radius-proportional barrier we want.
				{ parent: this.project, protect: true },
			)

			new gcp.artifactregistry.RepositoryIamMember(
				'prod-ci-backend-ar-reader',
				{
					repository: backendArtifactRegistry.name,
					location: Regions.Osaka,
					project: this.project.projectId,
					role: 'roles/artifactregistry.reader',
					member: PROD_CI_SA_EMAIL,
				},
				// protect: true — same critical-path rationale as the
				// frontend grant; the backend matrix has 4 images and
				// loss of this binding breaks every subsequent backend
				// release at the digest-resolve step.
				{ parent: this.project, protect: true },
			)
		}

		// 4.5. Cloud KMS — etcd CMEK key for the prod GKE cluster.
		// Application-layer Secrets Encryption is irreversible at cluster
		// creation, so the key must exist before KubernetesComponent runs.
		// Skipped for dev: dev cluster does not enable etcd CMEK to keep the
		// dev resource footprint minimal.
		const kms =
			environment === 'prod'
				? new KmsComponent('gke-cluster-kms', {
						project: this.project,
						region: Regions.Osaka,
						environment,
					})
				: undefined

		const osakaConfig = NetworkConfig.Osaka

		// 5. GKE Autopilot Cluster — gated by `workloadEnabled` to enable
		// the dev shutdown flow described in
		// docs/runbooks/dev-shutdown-restart.md. The Cloud SQL instance
		// (§6) is hoisted out of this guard so it can be `STOPped` rather
		// than destroyed (data preservation). WIF (§7) and Cost Guardrails
		// (§9) remain unguarded so GitHub Actions OIDC and billing alerts
		// persist while the workload tier is down.
		if (workloadEnabled) {
			const kubernetes = new KubernetesComponent('kubernetes-cluster', {
				project: this.project,
				environment,
				region: Regions.Osaka,
				regionName: RegionNames.Osaka,
				networkId: network.network.id,
				subnetCidr: osakaConfig.subnetCidr,
				podsCidr: osakaConfig.podsCidr,
				servicesCidr: osakaConfig.servicesCidr,
				masterCidr: osakaConfig.masterCidr,
				etcdCmekKeyName: kms?.keyName,
				artifactRegistries: [
					backendArtifactRegistry,
					frontendArtifactRegistry,
				],
				secrets: [
					...(lastFmApiKey
						? [
								{
									name: 'lastfm-api-key',
									value: lastFmApiKey,
								},
							]
						: []),
					...(blockchainConfig?.deployerPrivateKey
						? [
								{
									name: 'blockchain-deployer-private-key',
									value: pulumi.secret(
										blockchainConfig.deployerPrivateKey,
									),
								},
							]
						: []),
					...(blockchainConfig?.rpcUrl
						? [
								{
									name: 'blockchain-rpc-url',
									value: pulumi.secret(
										blockchainConfig.rpcUrl,
									),
								},
							]
						: []),
					...(blockchainConfig?.bundlerApiKey
						? [
								{
									name: 'blockchain-bundler-api-key',
									value: pulumi.secret(
										blockchainConfig.bundlerApiKey,
									),
								},
							]
						: []),
					...(gcpConfig.postgresAdminPassword
						? [
								{
									name: 'postgres-admin-password',
									value: pulumi.secret(
										gcpConfig.postgresAdminPassword,
									),
								},
							]
						: []),
					...(gcpConfig.vapidPrivateKey
						? [
								{
									name: 'vapid-private-key',
									value: pulumi.secret(
										gcpConfig.vapidPrivateKey,
									),
								},
							]
						: []),
					...(fanartTvApiKey
						? [
								{
									name: 'fanarttv-api-key',
									value: fanartTvApiKey,
								},
							]
						: []),
					...(zitadelMachineKey
						? [
								{
									name: 'zitadel-machine-key-for-backend-app',
									value: pulumi.secret(zitadelMachineKey),
								},
							]
						: []),
				],
				esoOnlySecrets: [
					...(gcpConfig.argocdGoogleChatWebhookUrl
						? [
								{
									name: 'argocd-google-chat-webhook-url',
									value: pulumi.secret(
										gcpConfig.argocdGoogleChatWebhookUrl,
									),
								},
							]
						: []),
					// PAT consumed only by the zitadel-login pod (Login V2 UI). ESO in
					// the `zitadel` namespace mirrors this into a K8s Secret which the
					// pod mounts as a file referenced by ZITADEL_SERVICE_USER_TOKEN_FILE.
					// Backend-app does not need access — the backend talks to Zitadel
					// via its own JWT-key (zitadel-machine-key-for-backend-app), not this PAT.
					...(zitadelLoginPat
						? [
								{
									name: 'zitadel-login-pat',
									value: pulumi.secret(zitadelLoginPat),
								},
							]
						: []),
				],
			})

			this.workloadSAs = {
				backendAppEmail: kubernetes.backendAppServiceAccountEmail,
				zitadelEmail: kubernetes.zitadelServiceAccountEmail,
				esoEmail: kubernetes.esoServiceAccountEmail,
				subnetId: kubernetes.subnet.id,
			}
		}

		// 6. Cloud SQL Instance (Postgres).
		// Always provisioned regardless of `workloadEnabled`. When the
		// workload tier is down, the instance is set to
		// `activationPolicy: NEVER` (stopped — CPU/RAM billing halts, disk
		// + PITR backup retention continues) so dev data survives the
		// shutdown window. The PSC consumer endpoint + cluster-SA IAM SQL
		// users are still gated on `workloadEnabled` inside the component
		// because they bind to cluster-only resources (subnet + Workload
		// Identity SAs).
		new PostgresComponent('postgres', {
			project: this.project,
			region: Regions.Osaka,
			regionName: RegionNames.Osaka,
			environment,
			workloadEnabled,
			subnetId: this.workloadSAs?.subnetId,
			networkId: network.network.id,
			pscEndpointIp: osakaConfig.postgresPscIp,
			dnsZoneName: network.sqlZone.name,
			appServiceAccountEmail: this.workloadSAs?.backendAppEmail,
			zitadelServiceAccountEmail: this.workloadSAs?.zitadelEmail,
			iamDatabaseUsers: cloudSqlUsers,
			postgresAdminPassword: gcpConfig.postgresAdminPassword
				? pulumi.secret(gcpConfig.postgresAdminPassword)
				: undefined,
		})

		// 7. Workload Identity Federation
		const wif = new WorkloadIdentityComponent({
			environment,
			folder: this.folder,
			project: this.project,
		})
		this.githubWorkloadIdentityProvider = wif.githubProvider.name
		this.githubActionsSAEmail = wif.githubActionsSA.email

		// 8. Monitoring (Log-Based Alerts + Notification Channels).
		// Runs in all envs (per `refactor-unify-env-dispatch` D4). The outer
		// `gcpConfig.monitoring?.slackNotificationChannels` guard remains as
		// the materialization gate — ESC seeding (Slack channel ID from the
		// GCP Console OAuth flow) controls whether these resources exist
		// in any given env's stack state. Also gated on `workloadEnabled`:
		// alert policies reference cluster log filters that match nothing
		// while the cluster is destroyed (dev shutdown mode).
		if (
			workloadEnabled &&
			gcpConfig.monitoring?.slackNotificationChannels
		) {
			const { slackNotificationChannels, googleChatSpaces } =
				gcpConfig.monitoring
			// Cluster name + location are env-keyed so log-based alert
			// filters target the cluster actually deployed in the current
			// env. Without env-keying, prod alerts would silently match
			// dev cluster log entries (the §refactor-unify-env-dispatch
			// devil's-advocate-C4 bug fix).
			const clusterNameByEnv: Record<Environment, string> = {
				dev: `standard-cluster-${RegionNames.Osaka}`,
				prod: `autopilot-cluster-${RegionNames.Osaka}`,
			}
			// `resource.labels.location` is the zone for dev's zonal Standard
			// cluster, but the bare region for prod's regional Autopilot
			// cluster.
			const clusterLocationByEnv: Record<Environment, string> = {
				dev: `${Regions.Osaka}-a`,
				prod: Regions.Osaka,
			}
			const monitoring = new MonitoringComponent('monitoring', {
				project: this.project,
				slackNotificationChannelIds: [
					slackNotificationChannels.alertBackend,
				],
				googleChatSpaceIds: googleChatSpaces
					? [googleChatSpaces.alertBackend]
					: undefined,
				clusterLocation: clusterLocationByEnv[environment],
				clusterName: clusterNameByEnv[environment],
			})

			// Zitadel observability: latency p99 alert + JWT error rate
			// alert + connection-pool dashboard. Runs in all envs (per
			// `refactor-unify-env-dispatch` D4). Threshold values are
			// generous (50× over steady-state) and won't page on pre-launch
			// prod traffic; future threshold tuning is operational concern.
			new ZitadelMonitoringComponent('zitadel-monitoring', {
				project: this.project,
				slackNotificationChannelIds: [
					slackNotificationChannels.alertBackend,
				],
				googleChatChannels: monitoring.googleChatChannels,
			})
		}

		// 9. Cost Guardrails (all envs).
		// Runs in any env that has `gcpConfig.billingAlertEmail` seeded in
		// ESC. Per `refactor-unify-env-dispatch` D4, no env-gated wrapper.
		// Both `cost-budget` and `billing-alert-email` resources are
		// currently DORMANT in all envs (neither dev nor prod ESC has
		// `billingAlertEmail` seeded). The rename from `dev-cost-budget` →
		// `cost-budget` (and the parallel `dev-billing-alert-email` →
		// `billing-alert-email`) triggers no destroy+create on the first
		// `pulumi up` of this refactor because there's no existing state
		// to migrate.
		if (gcpConfig.billingAlertEmail) {
			// Cloud Billing Budget needs `billingbudgets.googleapis.com`
			// enabled on the consuming project. The `gcp.billing.Budget`
			// resource itself doesn't have an implicit dependency on the
			// API, so we declare it explicitly and dependsOn-link below.
			// First prod up of this block on 2026-05-15 failed at
			// `gcp.billing.Budget` because the API wasn't yet enabled;
			// codifying the API enable here is the IaC fix.
			const billingBudgetsApi = new gcp.projects.Service(
				'billingbudgets',
				{
					project: this.projectId,
					service: 'billingbudgets.googleapis.com',
					// Mirrors `ApiService` — dev gets `false` to avoid
					// re-enable latency on shutdown/restart cycles; prod
					// gets `true` so a clean `pulumi destroy` flips the
					// API off and `gcloud projects delete` can finish
					// without a manual `gcloud services disable` pass.
					disableOnDestroy: environment !== 'dev',
				},
				{ parent: this.project },
			)

			const billingEmailChannel = new gcp.monitoring.NotificationChannel(
				'billing-alert-email',
				{
					project: this.projectId,
					displayName: 'Billing alert email',
					type: 'email',
					labels: {
						email_address: gcpConfig.billingAlertEmail,
					},
				},
				{ parent: this.project },
			)

			new gcp.billing.Budget(
				'cost-budget',
				{
					billingAccount: gcpConfig.billingAccount,
					displayName: `liverty-music-${environment} monthly budget`,
					budgetFilter: {
						projects: [
							pulumi.interpolate`projects/${this.project.number}`,
						],
					},
					amount: {
						specifiedAmount: {
							currencyCode: 'JPY',
							units: gcpConfig.budgetAmountJpy ?? '3000',
						},
					},
					thresholdRules: [
						{ thresholdPercent: 0.5 },
						{ thresholdPercent: 0.9 },
						{ thresholdPercent: 1.0 },
					],
					allUpdatesRule: {
						disableDefaultIamRecipients: false,
						monitoringNotificationChannels: [
							billingEmailChannel.name,
						],
					},
				},
				{ parent: this.project, dependsOn: [billingBudgetsApi] },
			)
		}
	}
}
