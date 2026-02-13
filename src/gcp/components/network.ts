import * as cloudflare from '@pulumi/cloudflare'
import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { toKebabCase } from '../../lib/lib.js'
import type { Region, RegionName } from '../region.js'
import { ApiService } from '../services/api.js'

export interface NetworkComponentArgs {
	region: Region
	regionName: RegionName
	project: gcp.organizations.Project
	environment: string
	cloudflareConfig: {
		apiToken: pulumi.Input<string>
		zoneId: pulumi.Input<string>
	}
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

		const { region, regionName, project, cloudflareConfig, environment } =
			args

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
		if (environment !== 'prod') {
			// Derive publicDomain from environment (e.g., "dev.liverty-music.app")
			const tld = 'liverty-music.app'
			const managedZoneName = `${environment}.${tld}`

			// Enable Certificate Manager API
			const certManagerApi = apiService.enableApis(
				['certificatemanager.googleapis.com' as any],
				this,
			)

			// Create public DNS zone
			const publicZone = new gcp.dns.ManagedZone(
				`${toKebabCase(tld)}-public-zone`,
				{
					name: `${toKebabCase(tld)}-public-zone`,
					dnsName: `${managedZoneName}.`,
					visibility: 'public',
					description: `Public zone for ${managedZoneName}`,
				},
				{ parent: this, dependsOn: enabledApis },
			)

			this.publicZoneNameservers = publicZone.nameServers

			const cloudflareProvider = new cloudflare.Provider(
				'cloudflare-provider',
				{
					apiToken: cloudflareConfig.apiToken,
				},
				{ parent: this },
			)

			// Create NS records in Cloudflare for subdomain delegation
			publicZone.nameServers.apply((nameservers) => {
				nameservers.forEach((ns, index) => {
					new cloudflare.DnsRecord(
						`${toKebabCase(tld)}-dns-delegation-ns-${index}`,
						{
							zoneId: cloudflareConfig.zoneId,
							name: environment, // Cloudflare automatically appends the zone name
							type: 'NS',
							content: ns.endsWith('.') ? ns : `${ns}.`,
							ttl: 3600,
							comment: `Delegate ${managedZoneName} to Cloud DNS`,
						},
						{
							parent: this,
							provider: cloudflareProvider,
							// aliases: [
							// 	{
							// 		type: 'cloudflare:index/dnsRecord:DnsRecord',
							// 	},
							// ],
						},
					)
				})
			})

			// Certificate Manager: DNS Authorization
			const dnsAuth = new gcp.certificatemanager.DnsAuthorization(
				'api-gateway-dns-auth',
				{
					name: 'api-gateway-dns-auth',
					location: 'global',
					domain: `api.${managedZoneName}`,
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Certificate Manager: Google-managed Certificate
			const cert = new gcp.certificatemanager.Certificate(
				'api-gateway-cert',
				{
					name: 'api-gateway-cert',
					location: 'global',
					scope: 'DEFAULT',
					managed: {
						domains: [`api.${managedZoneName}`],
						dnsAuthorizations: [dnsAuth.id],
					},
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Certificate Manager: Certificate Map
			const certMap = new gcp.certificatemanager.CertificateMap(
				'api-gateway-cert-map',
				{
					name: 'api-gateway-cert-map',
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Certificate Manager: Certificate Map Entry
			new gcp.certificatemanager.CertificateMapEntry(
				'api-gateway-cert-map-entry',
				{
					name: 'api-gateway-cert-map-entry',
					map: certMap.name,
					certificates: [cert.id],
					hostname: `api.${managedZoneName}`,
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Static IP for Gateway
			const staticIp = new gcp.compute.GlobalAddress(
				'api-gateway-static-ip',
				{
					name: 'api-gateway-static-ip',
					addressType: 'EXTERNAL',
					ipVersion: 'IPV4',
				},
				{ parent: this },
			)

			// DNS CNAME record for ACME challenge validation
			new gcp.dns.RecordSet(
				'api-gateway-dns-auth-cname',
				{
					name: dnsAuth.dnsResourceRecords.apply((r) => r[0].name),
					managedZone: publicZone.name,
					type: 'CNAME',
					ttl: 300,
					rrdatas: dnsAuth.dnsResourceRecords.apply((r) => [
						r[0].data,
					]),
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// DNS A record for api subdomain
			new gcp.dns.RecordSet(
				'api-gateway-a-record',
				{
					name: `api.${managedZoneName}.`,
					managedZone: publicZone.name,
					type: 'A',
					ttl: 300,
					rrdatas: [staticIp.address],
				},
				{ parent: this, dependsOn: enabledApis },
			)

			this.registerOutputs({
				publicZoneNameservers: publicZone.nameServers,
				certificate: cert.id,
			})
		}

		this.registerOutputs({
			networkName: this.network.name,
			sqlZoneName: this.sqlZone.name,
		})
	}
}
