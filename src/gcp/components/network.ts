import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Region, RegionName } from '../region.js'
import { ApiService } from '../services/api.js'

export interface NetworkComponentArgs {
	region: Region
	regionName: RegionName
	project: gcp.organizations.Project
	publicDomain?: string
}

export class NetworkComponent extends pulumi.ComponentResource {
	public readonly network: gcp.compute.Network
	public readonly router?: gcp.compute.Router
	public readonly nat?: gcp.compute.RouterNat
	public readonly sqlZone: gcp.dns.ManagedZone
	public readonly publicZoneNameservers: pulumi.Output<string[]> | undefined

	constructor(
		name: string,
		args: NetworkComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:NetworkComponent', name, args, opts)

		const { region, regionName, project } = args

		const apiService = new ApiService(project)
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
			{ parent: this },
		)

		// 2. Private DNS Zone for Cloud SQL PSC (.sql.goog)
		// Detailed: The Go Cloud SQL Connector SDK requires the hashed domain (.sql.goog) for SNI/TLS verification.
		// Creating a regional zone (asia-northeast2.sql.goog.) keeps the scope clean and avoids conflicts
		// with other regions while allowing the SDK to resolve the recommended DNS name.
		this.sqlZone = new gcp.dns.ManagedZone(
			'cloud-sql-psc-zone',
			{
				name: 'cloud-sql-psc-zone',
				dnsName: 'asia-northeast2.sql.goog.',
				description: 'Private zone for Cloud SQL PSC resolution',
				visibility: 'private',
				privateVisibilityConfig: {
					networks: [{ networkUrl: this.network.id }],
				},
			},
			{ parent: this, dependsOn: enabledApis },
		)

		// 3. API Gateway Infrastructure Context
		// --- Prod Cost Reduction: Skip API Gateway infrastructure for production ---
		const environment = pulumi.getStack()
		if (environment === 'prod') {
			this.registerOutputs({
				networkName: this.network.name,
				sqlZoneName: this.sqlZone.name,
			})
			return
		}

		// 4. Cloud Router (for NAT)
		this.router = new gcp.compute.Router(
			`nat-router-${regionName}`,
			{
				name: `nat-router-${regionName}`,
				network: this.network.id,
				region: region,
			},
			{ parent: this },
		)

		// 5. Cloud NAT
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
			{ parent: this },
		)

		// 6. Public DNS Zone (for dev/staging subdomain delegation)
		// We use a dedicated zone for the delegated subdomain to maintain ownership
		// without manual registrar updates.
		const publicDomain = args.publicDomain
		if (publicDomain) {
			const publicZone = new gcp.dns.ManagedZone(
				'liverty-music-zone',
				{
					name: 'liverty-music-zone',
					dnsName: `${publicDomain}.`,
					visibility: 'public',
					description: `Public zone for ${publicDomain}`,
				},
				{ parent: this, dependsOn: enabledApis },
			)

			this.publicZoneNameservers = publicZone.nameServers

			this.registerOutputs({
				publicZoneNameservers: publicZone.nameServers,
			})
		}

		this.registerOutputs({
			networkName: this.network.name,
			sqlZoneName: this.sqlZone.name,
		})
	}
}
