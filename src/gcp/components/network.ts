import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import { Region, RegionName } from '../region.js'
import { ApiService } from '../services/api.js'

export interface NetworkComponentArgs {
  region: Region
  regionName: RegionName
  projectId: pulumi.Input<string>
}

export class NetworkComponent extends pulumi.ComponentResource {
  public readonly network: gcp.compute.Network
  public readonly router: gcp.compute.Router
  public readonly nat: gcp.compute.RouterNat
  public readonly pscZone: gcp.dns.ManagedZone

  constructor(name: string, args: NetworkComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:NetworkComponent', name, args, opts)

    const { region, regionName, projectId } = args

    const apiService = new ApiService(projectId)
    const enabledApis = apiService.enableApis(['dns.googleapis.com'], this)

    // 1. VPC Network (Custom Mode)
    // Global VPC Network is unique per project.
    this.network = new gcp.compute.Network(
      'global-vpc',
      {
        name: 'global-vpc',
        autoCreateSubnetworks: false,
        routingMode: 'GLOBAL',
      },
      { parent: this }
    )

    // 2. Private DNS Zone for Private Service Connect (psc.internal)
    this.pscZone = new gcp.dns.ManagedZone(
      'private-service-connect-zone',
      {
        name: 'private-service-connect-zone',
        dnsName: 'psc.internal.',
        description: 'Common DNS zone for Private Service Connect services',
        visibility: 'private',
        privateVisibilityConfig: {
          networks: [{ networkUrl: this.network.id }],
        },
      },
      { parent: this, dependsOn: enabledApis }
    )

    // 3. Cloud Router (for NAT)
    this.router = new gcp.compute.Router(
      `nat-router-${regionName}`,
      {
        name: `nat-router-${regionName}`,
        network: this.network.id,
        region: region,
      },
      { parent: this }
    )

    // 4. Cloud NAT
    this.nat = new gcp.compute.RouterNat(
      `nat-${regionName}`,
      {
        name: `nat-${regionName}`,
        router: this.router.name,
        region: region,
        natIpAllocateOption: 'AUTO_ONLY',
        sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
        enableDynamicPortAllocation: true,
        logConfig: {
          enable: true,
          filter: 'ERRORS_ONLY',
        },
      },
      { parent: this }
    )

    this.registerOutputs({
      networkName: this.network.name,
      pscZoneName: this.pscZone.name,
    })
  }
}
