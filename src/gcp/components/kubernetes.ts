import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import { Region, RegionName } from '../region.js'
import { ApiService } from '../services/api.js'

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
}

export class KubernetesComponent extends pulumi.ComponentResource {
  public readonly cluster: gcp.container.Cluster
  public readonly subnet: gcp.compute.Subnetwork

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
    } = args

    const apiService = new ApiService(project)
    const enabledApis = apiService.enableApis(['container.googleapis.com'], this)

    // 1. Dedicated Subnet for GKE
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

    // 2. GKE Autopilot Cluster
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
    })
  }
}
