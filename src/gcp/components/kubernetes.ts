import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Region, RegionName } from '../region.js'
import { ApiService } from '../services/api.js'
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
	 * The Artifact Registry repositories to grant pull access to.
	 */
	artifactRegistries: gcp.artifactregistry.Repository[]

	/**
	 * Runtime secrets to provision in GCP Secret Manager and grant access to the backend-app SA.
	 * Each entry creates a secret, a version (value from Pulumi config), and an IAM accessor binding.
	 */
	secrets?: SecretConfig[]
}

export class KubernetesComponent extends pulumi.ComponentResource {
	public readonly subnet: gcp.compute.Subnetwork
	public readonly nodeServiceAccountEmail: pulumi.Output<string>
	public readonly backendAppServiceAccountEmail: pulumi.Output<string>

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
			artifactRegistries,
			secrets = [],
		} = args

		const apiService = new ApiService(project)
		const enabledApis = apiService.enableApis(
			['container.googleapis.com'],
			this,
		)
		const enabledSecretManagerApi =
			secrets.length > 0
				? apiService.enableApis(['secretmanager.googleapis.com'], this)
				: []

		// 1. Dedicated Service Account for GKE Nodes
		const iamSvc = new IamService(project)
		const gkeNodeSa = iamSvc.createServiceAccount(
			`gke-node`,
			`gke-node`,
			`GKE Node Service Account`,
			'Service Account for GKE Autopilot Nodes',
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
		const esoName = 'external-secrets'
		const esoNamespace = 'external-secrets'
		const esoSa = iamSvc.createServiceAccount(
			`liverty-music-${esoName}`,
			esoName,
			'External Secrets Operator Service Account',
			'Service account for ESO controller to read GCP Secret Manager secrets',
			this,
		)
		// Allow K8s SA external-secrets/external-secrets to impersonate this GCP SA.
		iamSvc.bindKubernetesSaUser(esoName, esoSa, esoNamespace, this)

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
			return
		}

		// 6. GKE Autopilot Cluster
		const cluster = new gcp.container.Cluster(
			`cluster-${regionName}`,
			{
				name: `cluster-${regionName}`,
				location: region,
				enableAutopilot: true,
				deletionProtection: environment !== 'dev',
				network: networkId,
				subnetwork: this.subnet.id,
				datapathProvider: 'ADVANCED_DATAPATH', // Dataplane V2 (default for Autopilot)

				// Use custom service account for nodes (Autopilot)
				clusterAutoscaling: {
					autoProvisioningDefaults: {
						serviceAccount: gkeNodeSa.email,
					},
				},

				// Networking
				ipAllocationPolicy: {
					clusterSecondaryRangeName: 'pods-range',
					servicesSecondaryRangeName: 'services-range',
				},

				// Security
				privateClusterConfig: {
					enablePrivateNodes: true,
					enablePrivateEndpoint: false, // Public endpoint enabled for development access
					masterIpv4CidrBlock: masterCidr,
				},

				// Release Channel
				releaseChannel: {
					channel: 'REGULAR',
				},

				// Cost Management
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
		})
	}
}
