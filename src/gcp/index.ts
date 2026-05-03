import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { CloudflareConfig } from '../cloudflare/config.js'
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
	environment: 'dev' | 'staging' | 'prod'
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
	public readonly publicZone: gcp.dns.ManagedZone | undefined
	public readonly publicZoneNameservers: pulumi.Output<string[]> | undefined
	/** Backend application GCP SA email — exposed so callers can grant per-secret bindings. */
	public readonly backendAppServiceAccountEmail: pulumi.Output<string>
	/** Self-hosted Zitadel GCP SA email — exposed so Zitadel-scoped secrets can bind. */
	public readonly zitadelServiceAccountEmail: pulumi.Output<string>
	/** External Secrets Operator GCP SA email — exposed for ESO per-secret bindings. */
	public readonly esoServiceAccountEmail: pulumi.Output<string>

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
		this.publicZone = network.publicZone
		this.publicZoneNameservers = network.publicZoneNameservers

		// 4. Concert Data Store (Vertex AI Search)
		// new ConcertDataStore({
		//   project: this.project,
		//   region: Regions.Osaka,
		// })

		// 4. Artifact Registry
		const backendArtifactRegistry = new gcp.artifactregistry.Repository(
			'github-backend-repository',
			{
				repositoryId: 'backend',
				location: Regions.Osaka,
				format: 'DOCKER',
				project: this.project.projectId,
				description: 'Docker repository for GitHub Backend Repository',
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
			},
			{ parent: this.project },
		)

		// 5. GKE Autopilot Cluster
		const osakaConfig = NetworkConfig.Osaka
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
								value: pulumi.secret(blockchainConfig.rpcUrl),
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
								value: pulumi.secret(gcpConfig.vapidPrivateKey),
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
								name: 'zitadel-machine-key',
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
				// via its own JWT-key (zitadel-machine-key), not this PAT.
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

		this.backendAppServiceAccountEmail =
			kubernetes.backendAppServiceAccountEmail
		this.zitadelServiceAccountEmail = kubernetes.zitadelServiceAccountEmail
		this.esoServiceAccountEmail = kubernetes.esoServiceAccountEmail

		// 6. Cloud SQL Instance (Postgres)
		new PostgresComponent('postgres', {
			project: this.project,
			region: Regions.Osaka,
			regionName: RegionNames.Osaka,
			environment,
			subnetId: kubernetes.subnet.id,
			networkId: network.network.id,
			pscEndpointIp: osakaConfig.postgresPscIp,
			dnsZoneName: network.sqlZone.name,
			appServiceAccountEmail: kubernetes.backendAppServiceAccountEmail,
			zitadelServiceAccountEmail: kubernetes.zitadelServiceAccountEmail,
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

		// 8. Monitoring (Log-Based Alerts + Notification Channels)
		if (gcpConfig.monitoring?.slackNotificationChannels) {
			const { slackNotificationChannels, googleChatSpaces } =
				gcpConfig.monitoring
			const monitoring = new MonitoringComponent('monitoring', {
				project: this.project,
				slackNotificationChannelIds: [
					slackNotificationChannels.alertBackend,
				],
				googleChatSpaceIds: googleChatSpaces
					? [googleChatSpaces.alertBackend]
					: undefined,
				clusterLocation: Regions.Osaka,
				clusterName: `cluster-${RegionNames.Osaka}`,
			})

			// Zitadel observability: latency p99 alert + JWT error rate
			// alert + connection-pool dashboard. Dev-only — `self-hosted-zitadel`
			// is dev-scoped until cooldown ends and prod migration begins,
			// so the thresholds here are tuned to dev-traffic patterns and
			// would page constantly on prod traffic without re-tuning.
			// Reuses the same notification channels as the backend alerts;
			// adding a separate Zitadel channel is overkill while alerting
			// is rare.
			if (environment === 'dev') {
				new ZitadelMonitoringComponent('zitadel-monitoring', {
					project: this.project,
					slackNotificationChannelIds: [
						slackNotificationChannels.alertBackend,
					],
					googleChatChannels: monitoring.googleChatChannels,
				})
			}
		}

		// 9. Cost Guardrails (Dev only)
		// Billing budget alert and per-API quota overrides to cap runaway external
		// API costs. These are intentionally restricted to dev where quota limits
		// are low enough to be meaningful as a safeguard.
		if (environment === 'dev') {
			// Billing Budget: alert at 50%/90%/100% of ¥3,000/month (~$20 USD)
			if (gcpConfig.billingAlertEmail) {
				const billingEmailChannel =
					new gcp.monitoring.NotificationChannel(
						'dev-billing-alert-email',
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
					'dev-cost-budget',
					{
						billingAccount: gcpConfig.billingAccount,
						displayName: 'liverty-music-dev monthly budget',
						budgetFilter: {
							projects: [
								pulumi.interpolate`projects/${this.project.number}`,
							],
						},
						amount: {
							specifiedAmount: {
								currencyCode: 'JPY',
								units: '3000',
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
					{ parent: this.project },
				)
			}
		}
	}
}
