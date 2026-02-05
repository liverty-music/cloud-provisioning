import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import { Region, RegionName } from '../region.js'
import { ApiService } from '../services/api.js'
import { IamService, Roles } from '../services/iam.js'

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
   * The Artifact Registry repository to grant pull access to.
   */
  artifactRegistry: gcp.artifactregistry.Repository
}

export class KubernetesComponent extends pulumi.ComponentResource {
  public readonly cluster: gcp.container.Cluster
  public readonly subnet: gcp.compute.Subnetwork
  public readonly nodeServiceAccountEmail: pulumi.Output<string>
  public readonly backendAppServiceAccountEmail: pulumi.Output<string>

  constructor(name: string, args: KubernetesComponentArgs, opts?: pulumi.ComponentResourceOptions) {
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
      artifactRegistry,
    } = args

    const apiService = new ApiService(project)
    const enabledApis = apiService.enableApis(['container.googleapis.com'], this)

    // 1. Dedicated Service Account for GKE Nodes
    const iamSvc = new IamService(project)
    const gkeNodeSa = iamSvc.createServiceAccount(
      `gke-node`,
      `gke-node`,
      `GKE Node Service Account`,
      'Service Account for GKE Autopilot Nodes',
      this
    )
    this.nodeServiceAccountEmail = gkeNodeSa.email

    // Grant standard GKE node roles
    iamSvc.bindProjectRoles(
      [Roles.Logging.LogWriter, Roles.Monitoring.MetricWriter],
      `gke-node`,
      gkeNodeSa.email,
      this
    )

    // Grant permission to pull from Artifact Registry
    iamSvc.bindArtifactRegistryReader(`gke-node`, gkeNodeSa.email, artifactRegistry, region, this)

    // 2. Application Service Account (backend-app)
    const backendApp = 'backend-app'
    const namespace = 'backend'
    const backendAppSa = iamSvc.createServiceAccount(
      `liverty-music-${backendApp}`,
      backendApp,
      'Liverty Music Backend Application Service Account',
      'Service account for backend application',
      this
    )
    this.backendAppServiceAccountEmail = backendAppSa.email

    // Grant permission to pull from Artifact Registry
    iamSvc.bindArtifactRegistryReader(
      backendApp,
      backendAppSa.email,
      artifactRegistry,
      region,
      this
    )
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
      this
    )

    // Bind Kubernetes Service Account to Workload Identity
    iamSvc.bindKubernetesSaUser(backendApp, backendAppSa, namespace, this)

    // 3. Dedicated Subnet for GKE
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
      { parent: this }
    )

    // 3. GKE Autopilot Cluster
    this.cluster = new gcp.container.Cluster(
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
      { parent: this, dependsOn: enabledApis }
    )

    this.registerOutputs({
      clusterName: this.cluster.name,
      clusterEndpoint: this.cluster.endpoint,
      subnetId: this.subnet.id,
      nodeServiceAccountEmail: this.nodeServiceAccountEmail,
      backendAppServiceAccountEmail: this.backendAppServiceAccountEmail,
    })
  }
}
