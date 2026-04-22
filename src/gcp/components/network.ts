import * as cloudflare from '@pulumi/cloudflare'
import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { toKebabCase } from '../../lib/lib.js'
import type { Region, RegionName } from '../region.js'
import { ApiService } from '../services/api.js'

export interface PostmarkDnsConfig {
	dkimSelector: string
	dkimPublicKey: string
}

export interface NetworkComponentArgs {
	region: Region
	regionName: RegionName
	project: gcp.organizations.Project
	environment: string
	cloudflareConfig: {
		apiToken: pulumi.Input<string>
		zoneId: pulumi.Input<string>
	}
	postmarkConfig: PostmarkDnsConfig
}

export class NetworkComponent extends pulumi.ComponentResource {
	public readonly network: gcp.compute.Network
	public readonly router?: gcp.compute.Router
	public readonly nat?: gcp.compute.RouterNat
	public readonly sqlZone: gcp.dns.ManagedZone
	public readonly publicZone: gcp.dns.ManagedZone | undefined
	public readonly publicZoneNameservers: pulumi.Output<string[]> | undefined

	constructor(
		name: string,
		args: NetworkComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:NetworkComponent', name, args, opts)

		const {
			region,
			regionName,
			project,
			cloudflareConfig,
			environment,
			postmarkConfig,
		} = args

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

		// 3. Private Google Access DNS zones
		// Completes the PGA configuration (subnet flag is already set in kubernetes.ts).
		// Without these zones, *.googleapis.com resolves to public IPs and traffic is
		// forced through Cloud NAT even though privateIpGoogleAccess: true is set.
		//
		// VIP selection: private.googleapis.com (199.36.153.8/30)
		//   - Allows access to most Google APIs including services NOT protected by
		//     VPC Service Controls (e.g., Firebase Cloud Messaging).
		//   - Switch to restricted.googleapis.com (199.36.153.4/30) only if/when
		//     adopting VPC Service Controls — the restricted VIP actively blocks
		//     services not on the VPC-SC supported product list.
		//   - This project does not use VPC-SC; the restricted VIP was previously
		//     configured by mistake, causing FCM Web Push delivery to return 403.
		//
		// The private DNS zone redirects traffic for ALL nodes regardless of whether
		// they have external IPs. Cloud DNS resolution is consulted before public DNS,
		// so even dev nodes (enablePrivateNodes: false) are affected.
		//
		// Structure follows GCP documentation exactly (one zone, CNAME + A records):
		// https://cloud.google.com/vpc/docs/configure-private-google-access
		//   *.googleapis.com  CNAME  private.googleapis.com.    (in googleapis.com zone)
		//   private.googleapis.com  A  199.36.153.8/30           (same zone)
		// Both records MUST be in the same zone — Cloud DNS does not follow CNAMEs
		// that point to names in a different private zone.
		const pgaGoogleapisZone = new gcp.dns.ManagedZone(
			'pga-googleapis-zone',
			{
				name: 'pga-googleapis-zone',
				dnsName: 'googleapis.com.',
				description:
					'Private zone for Private Google Access (private VIP). Contains CNAME + A records per https://cloud.google.com/vpc/docs/configure-private-google-access',
				visibility: 'private',
				privateVisibilityConfig: {
					networks: [{ networkUrl: this.network.id }],
				},
			},
			{ parent: this, dependsOn: enabledApis },
		)

		// Wildcard CNAME: *.googleapis.com → private.googleapis.com (same zone)
		new gcp.dns.RecordSet(
			'pga-googleapis-cname',
			{
				name: '*.googleapis.com.',
				managedZone: pgaGoogleapisZone.name,
				type: 'CNAME',
				ttl: 300,
				rrdatas: ['private.googleapis.com.'],
			},
			{ parent: this, dependsOn: enabledApis },
		)

		// A record for private.googleapis.com in the SAME googleapis.com zone.
		// Must be in the same zone as the CNAME above — intra-zone resolution works,
		// cross-zone CNAME resolution does not in Cloud DNS private zones.
		new gcp.dns.RecordSet(
			'pga-private-googleapis-a',
			{
				name: 'private.googleapis.com.',
				managedZone: pgaGoogleapisZone.name,
				type: 'A',
				ttl: 300,
				rrdatas: [
					'199.36.153.8',
					'199.36.153.9',
					'199.36.153.10',
					'199.36.153.11',
				],
			},
			{ parent: this, dependsOn: enabledApis },
		)

		// 4. Postmark Email DNS Records (prod: Cloudflare DNS)
		if (environment === 'prod') {
			const cfProvider = new cloudflare.Provider(
				'postmark-cloudflare-provider',
				{ apiToken: cloudflareConfig.apiToken },
				{ parent: this },
			)

			// Postmark DKIM settings (https://account.postmarkapp.com/signature_domains/4206868)
			new cloudflare.DnsRecord(
				'postmark-dkim',
				{
					zoneId: cloudflareConfig.zoneId,
					name: `${postmarkConfig.dkimSelector}._domainkey.mail`,
					type: 'TXT',
					content: `"k=rsa;p=${postmarkConfig.dkimPublicKey}"`,
					ttl: 300,
					comment:
						'Postmark DKIM settings (https://account.postmarkapp.com/signature_domains/4206868)',
				},
				{ parent: this, provider: cfProvider },
			)

			// Postmark Return-Path settings (https://account.postmarkapp.com/signature_domains/4206868)
			new cloudflare.DnsRecord(
				'postmark-return-path',
				{
					zoneId: cloudflareConfig.zoneId,
					name: 'pm-bounces.mail',
					type: 'CNAME',
					content: 'pm.mtasv.net',
					ttl: 300,
					comment:
						'Postmark Return-Path settings (https://account.postmarkapp.com/signature_domains/4206868)',
				},
				{ parent: this, provider: cfProvider },
			)
		}

		// --- Prod Cost Reduction: Skip API Gateway infrastructure for production ---
		if (environment === 'prod') {
			this.registerOutputs({
				networkName: this.network.name,
				sqlZoneName: this.sqlZone.name,
			})
			return
		}

		// 4. Cloud Router + Cloud NAT (staging only)
		// Dev uses public nodes (enablePrivateNodes: false), so Cloud NAT is not needed.
		// Staging retains private nodes and requires NAT for internet egress.
		if (environment !== 'dev') {
			this.router = new gcp.compute.Router(
				`nat-router-${regionName}`,
				{
					name: `nat-router-${regionName}`,
					network: this.network.id,
					region: region,
				},
				{ parent: this },
			)

			this.nat = new gcp.compute.RouterNat(
				`nat-${regionName}`,
				{
					name: `nat-${regionName}`,
					router: this.router.name,
					region: region,
					natIpAllocateOption: 'AUTO_ONLY',
					sourceSubnetworkIpRangesToNat:
						'ALL_SUBNETWORKS_ALL_IP_RANGES',
					enableDynamicPortAllocation: true,
					logConfig: {
						enable: true,
						filter: 'ERRORS_ONLY',
					},
				},
				{ parent: this },
			)
		}

		// 5. Public DNS Zone (for dev/staging subdomain delegation)
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

			this.publicZone = publicZone
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

			// Certificate Manager: DNS Authorization for Backend Server
			const backendServerDnsAuth =
				new gcp.certificatemanager.DnsAuthorization(
					'backend-server-dns-auth',
					{
						name: 'backend-server-dns-auth',
						location: 'global',
						domain: `api.${managedZoneName}`,
					},
					{ parent: this, dependsOn: certManagerApi },
				)

			// Certificate Manager: DNS Authorization for Web App
			const webAppDnsAuth = new gcp.certificatemanager.DnsAuthorization(
				'web-app-dns-auth',
				{
					name: 'web-app-dns-auth',
					location: 'global',
					domain: `${managedZoneName}`,
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Certificate Manager: DNS Authorization for self-hosted Zitadel
			// (`auth.<managedZoneName>`). Needed so the Google-managed cert can
			// cover the Zitadel issuer hostname alongside api/web domains.
			const authDnsAuth = new gcp.certificatemanager.DnsAuthorization(
				'auth-dns-auth',
				{
					name: 'auth-dns-auth',
					location: 'global',
					domain: `auth.${managedZoneName}`,
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Certificate Manager: Google-managed Certificate (covers api, web, auth)
			const cert = new gcp.certificatemanager.Certificate(
				'api-gateway-cert',
				{
					name: 'api-gateway-cert',
					location: 'global',
					scope: 'DEFAULT',
					managed: {
						domains: [
							`api.${managedZoneName}`,
							`${managedZoneName}`,
							`auth.${managedZoneName}`,
						],
						dnsAuthorizations: [
							backendServerDnsAuth.id,
							webAppDnsAuth.id,
							authDnsAuth.id,
						],
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

			// Certificate Manager: Certificate Map Entry for Backend Server
			new gcp.certificatemanager.CertificateMapEntry(
				'backend-server-cert-map-entry',
				{
					name: 'backend-server-cert-map-entry',
					map: certMap.name,
					certificates: [cert.id],
					hostname: `api.${managedZoneName}`,
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Certificate Manager: Certificate Map Entry for self-hosted Zitadel
			new gcp.certificatemanager.CertificateMapEntry(
				'auth-cert-map-entry',
				{
					name: 'auth-cert-map-entry',
					map: certMap.name,
					certificates: [cert.id],
					hostname: `auth.${managedZoneName}`,
				},
				{ parent: this, dependsOn: certManagerApi },
			)

			// Certificate Manager: Certificate Map Entry for Web App
			new gcp.certificatemanager.CertificateMapEntry(
				'web-app-cert-map-entry',
				{
					name: 'web-app-cert-map-entry',
					map: certMap.name,
					certificates: [cert.id],
					hostname: `${managedZoneName}`,
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

			// DNS CNAME record for Backend Server ACME challenge validation
			new gcp.dns.RecordSet(
				'backend-server-dns-auth-cname',
				{
					name: backendServerDnsAuth.dnsResourceRecords.apply(
						(r) => r[0].name,
					),
					managedZone: publicZone.name,
					type: 'CNAME',
					ttl: 300,
					rrdatas: backendServerDnsAuth.dnsResourceRecords.apply(
						(r) => [r[0].data],
					),
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// DNS CNAME record for Web App ACME challenge validation
			new gcp.dns.RecordSet(
				'web-app-dns-auth-cname',
				{
					name: webAppDnsAuth.dnsResourceRecords.apply(
						(r) => r[0].name,
					),
					managedZone: publicZone.name,
					type: 'CNAME',
					ttl: 300,
					rrdatas: webAppDnsAuth.dnsResourceRecords.apply((r) => [
						r[0].data,
					]),
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// DNS A record for Backend Server
			new gcp.dns.RecordSet(
				'backend-server-a-record',
				{
					name: `api.${managedZoneName}.`,
					managedZone: publicZone.name,
					type: 'A',
					ttl: 300,
					rrdatas: [staticIp.address],
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// DNS A record for Web App
			new gcp.dns.RecordSet(
				'web-app-a-record',
				{
					name: `${managedZoneName}.`,
					managedZone: publicZone.name,
					type: 'A',
					ttl: 300,
					rrdatas: [staticIp.address],
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// DNS CNAME record for auth.<managedZoneName> ACME challenge validation
			new gcp.dns.RecordSet(
				'auth-dns-auth-cname',
				{
					name: authDnsAuth.dnsResourceRecords.apply(
						(r) => r[0].name,
					),
					managedZone: publicZone.name,
					type: 'CNAME',
					ttl: 300,
					rrdatas: authDnsAuth.dnsResourceRecords.apply((r) => [
						r[0].data,
					]),
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// DNS A record for self-hosted Zitadel — shares the Gateway static IP
			// with api/web. The HTTPRoute in k8s/namespaces/zitadel/base/httproute.yaml
			// routes traffic to the zitadel Service based on the Host header.
			new gcp.dns.RecordSet(
				'auth-a-record',
				{
					name: `auth.${managedZoneName}.`,
					managedZone: publicZone.name,
					type: 'A',
					ttl: 300,
					rrdatas: [staticIp.address],
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// Postmark Email DNS Records (dev/staging: GCP Cloud DNS)
			const mailSubdomain = `mail.${environment}`

			// Postmark DKIM settings (https://account.postmarkapp.com/signature_domains/4169912)
			new gcp.dns.RecordSet(
				'postmark-dkim',
				{
					name: `${postmarkConfig.dkimSelector}._domainkey.${mailSubdomain}.${tld}.`,
					managedZone: publicZone.name,
					type: 'TXT',
					ttl: 300,
					rrdatas: [`"k=rsa;p=${postmarkConfig.dkimPublicKey}"`],
				},
				{ parent: this, dependsOn: enabledApis },
			)

			// Postmark Return-Path settings (https://account.postmarkapp.com/signature_domains/4169912)
			new gcp.dns.RecordSet(
				'postmark-return-path',
				{
					name: `pm-bounces.${mailSubdomain}.${tld}.`,
					managedZone: publicZone.name,
					type: 'CNAME',
					ttl: 300,
					rrdatas: ['pm.mtasv.net.'],
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
