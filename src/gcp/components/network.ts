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

		// 4. Cloud Router + Cloud NAT (staging only)
		// Dev uses public nodes (enablePrivateNodes: false), so Cloud NAT is not
		// needed. Prod currently mirrors dev's public-node + no-NAT setup as
		// the cost-first pre-launch state (mutable; flip when real users
		// arrive — see docs/PROD_BOOTSTRAP_DECISIONS.md D6). Only staging
		// keeps private nodes today and therefore needs NAT for internet
		// egress.
		if (environment === 'staging') {
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

		// 5. Public DNS zones + Certificate Manager + shared Gateway resources.
		//
		// DNS topology differs by environment but the per-service resource
		// shape (DnsAuthorization + Certificate + CertificateMapEntry + A
		// record + ACME-challenge CNAME) is identical. The provisioning code
		// below is driven by two tables:
		//
		//   • SERVICES   — declarative catalog of every externally-facing
		//                  hostname this stack manages.
		//   • zoneTopology — env-derived list of Cloud DNS zones, each with
		//                  the SERVICES that live inside it.
		//
		// Dev/staging keep the original single-zone-per-env layout
		// (`<env>.liverty-music.app`); prod uses one zone per subdomain
		// (`api.liverty-music.app`, `auth.liverty-music.app`) because the
		// apex stays on Cloudflare. Pulumi resource names are preserved
		// across the refactor so existing dev state is not disturbed.

		const certManagerApi = apiService.enableApis(
			['certificatemanager.googleapis.com'],
			this,
		)

		const cloudflareProvider = new cloudflare.Provider(
			'cloudflare-provider',
			{ apiToken: cloudflareConfig.apiToken },
			{ parent: this },
		)

		const tld = 'liverty-music.app'

		const zoneTopology = buildZoneTopology(environment, tld)

		// Provision each zone + its Cloudflare NS delegation. Returns
		// per-zone bundles of (zone, services) used in the per-service loop.
		const provisionedZones = zoneTopology.map(
			({ zoneConfig, services }) => {
				const zone = new gcp.dns.ManagedZone(
					zoneConfig.resourceName,
					{
						name: zoneConfig.resourceName,
						dnsName: zoneConfig.dnsName,
						visibility: 'public',
						description: `Public zone for ${zoneConfig.dnsName.replace(/\.$/, '')}`,
					},
					{ parent: this, dependsOn: enabledApis },
				)

				// Cloudflare NS records: delegate this zone's apex to the
				// Cloud DNS nameservers. One record per NS server returned
				// by GCP (typically 4).
				zone.nameServers.apply((nameservers) => {
					nameservers.forEach((ns, index) => {
						new cloudflare.DnsRecord(
							`${zoneConfig.cloudflareNsResourcePrefix}-dns-delegation-ns-${index}`,
							{
								zoneId: cloudflareConfig.zoneId,
								name: zoneConfig.cloudflareNsName,
								type: 'NS',
								content: ns.endsWith('.') ? ns : `${ns}.`,
								ttl: 3600,
								comment: `Delegate ${zoneConfig.dnsName.replace(/\.$/, '')} to Cloud DNS`,
							},
							{ parent: this, provider: cloudflareProvider },
						)
					})
				})

				return { zone, services }
			},
		)

		// Expose the primary public zone for back-compat. For dev/staging
		// there is a single zone covering all hostnames. For prod multiple
		// zones exist; downstream consumers do not currently use this field
		// for prod, so leaving it unset (undefined) is safe.
		if (environment !== 'prod') {
			this.publicZone = provisionedZones[0]?.zone
			this.publicZoneNameservers = provisionedZones[0]?.zone.nameServers
		}

		// Shared Gateway resources: one CertificateMap and one static IP
		// across all hostnames in this stack (Gateway is a single ingress).
		const certMap = new gcp.certificatemanager.CertificateMap(
			'api-gateway-cert-map',
			{ name: 'api-gateway-cert-map' },
			{ parent: this, dependsOn: certManagerApi },
		)

		const staticIp = new gcp.compute.GlobalAddress(
			'api-gateway-static-ip',
			{
				name: 'api-gateway-static-ip',
				addressType: 'EXTERNAL',
				ipVersion: 'IPV4',
			},
			{ parent: this },
		)

		// Provision each service's hostname (DnsAuth + Cert + CertMapEntry
		// + A record + ACME CNAME) into its assigned zone.
		const certManagerAndDnsApis = [...certManagerApi, ...enabledApis]
		for (const { zone, services } of provisionedZones) {
			for (const svc of services) {
				provisionManagedHostname(
					this,
					{ name: svc.name, hostname: svc.hostname, zone },
					certMap,
					staticIp,
					certManagerAndDnsApis,
				)
			}
		}

		// Postmark Email DNS Records.
		// dev/staging: GCP Cloud DNS, records placed in the single subdomain
		// zone. prod: Cloudflare handles Postmark records at the apex (see
		// `if (environment === 'prod')` Cloudflare provider block above);
		// nothing to do here for prod.
		if (environment !== 'prod') {
			const publicZone = provisionedZones[0].zone
			const mailSubdomain = `mail.${environment}`

			// Postmark DKIM settings
			// (https://account.postmarkapp.com/signature_domains/4169912)
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

			// Postmark Return-Path settings
			// (https://account.postmarkapp.com/signature_domains/4169912)
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
		}

		this.registerOutputs({
			networkName: this.network.name,
			sqlZoneName: this.sqlZone.name,
			publicZoneNameservers: this.publicZoneNameservers,
		})
	}
}

/**
 * Declarative catalog of externally-facing services. Each entry maps a
 * service to its subdomain prefix. `subdomain: null` denotes a service
 * served at the zone apex (used by dev/staging where the apex is
 * `<env>.<tld>`; excluded for prod because the prod apex stays on
 * Cloudflare).
 *
 * The `name` is the Pulumi resource-name prefix and MUST NOT change for
 * existing services — it is part of the stack URN.
 */
const SERVICES: ReadonlyArray<{
	name: string
	subdomain: string | null
}> = [
	{ name: 'backend-server', subdomain: 'api' },
	{ name: 'web-app', subdomain: null },
	{ name: 'zitadel', subdomain: 'auth' },
]

/**
 * Config describing one Cloud DNS public zone and the Cloudflare NS
 * delegation that points the parent zone at it.
 */
interface ZoneConfig {
	/** Pulumi resource name for the gcp.dns.ManagedZone. */
	resourceName: string
	/** Cloud DNS `dnsName` (FQDN, trailing dot). */
	dnsName: string
	/**
	 * Cloudflare DNS record `name` field. Cloudflare appends the parent
	 * zone, so this is the subdomain label being delegated.
	 */
	cloudflareNsName: string
	/**
	 * Pulumi resource-name prefix for the Cloudflare NS DnsRecord resources.
	 * Kept separate from {@link cloudflareNsName} so dev's pre-existing URN
	 * (`liverty-music-app-dns-delegation-ns-*`) survives the refactor.
	 */
	cloudflareNsResourcePrefix: string
}

/**
 * Per-zone bundle returned by {@link buildZoneTopology}. Each zone owns
 * one or more services whose hostnames resolve inside it.
 */
interface ZoneTopologyEntry {
	zoneConfig: ZoneConfig
	services: Array<{ name: string; hostname: string }>
}

/**
 * Build the (zone × services) assignment for the current environment.
 *
 * - **dev / staging**: a single zone `<env>.<tld>` containing every
 *   service from {@link SERVICES}. The web app sits at the zone apex
 *   (hostname == zone dnsName), api/auth at subdomains.
 * - **prod**: one zone per non-apex service (apex stays on Cloudflare).
 *   The web app is excluded.
 *
 * Pulumi resource names returned for dev/staging mirror the names that
 * existed before this refactor, so the rewrite produces zero-diff on
 * dev. Prod adds new resources with distinct names.
 */
function buildZoneTopology(
	environment: string,
	tld: string,
): ZoneTopologyEntry[] {
	if (environment === 'prod') {
		return SERVICES.filter((svc) => svc.subdomain !== null).map((svc) => {
			const subdomain = svc.subdomain as string
			const fqdn = `${subdomain}.${tld}`
			return {
				zoneConfig: {
					resourceName: `${subdomain}-${toKebabCase(tld)}-public-zone`,
					dnsName: `${fqdn}.`,
					cloudflareNsName: subdomain,
					cloudflareNsResourcePrefix: subdomain,
				},
				services: [{ name: svc.name, hostname: fqdn }],
			}
		})
	}

	// dev / staging
	const managedZoneName = `${environment}.${tld}`
	return [
		{
			zoneConfig: {
				resourceName: `${toKebabCase(tld)}-public-zone`,
				dnsName: `${managedZoneName}.`,
				cloudflareNsName: environment,
				cloudflareNsResourcePrefix: toKebabCase(tld),
			},
			services: SERVICES.map((svc) => ({
				name: svc.name,
				hostname: svc.subdomain
					? `${svc.subdomain}.${managedZoneName}`
					: managedZoneName,
			})),
		},
	]
}

/**
 * Provision the per-hostname Pulumi resources that wire a service into
 * Google-managed TLS and DNS:
 *
 *   - `<name>-dns-auth`           — Certificate Manager DnsAuthorization
 *   - `<name>-cert`               — single-hostname Google-managed Certificate
 *   - `<name>-cert-map-entry`     — binds the cert to the shared
 *                                    {@link gcp.certificatemanager.CertificateMap}
 *   - `<name>-a-record`           — A record in {@link service.zone}
 *                                    pointing at {@link staticIp}
 *   - `<name>-dns-auth-cname`     — CNAME record satisfying the ACME
 *                                    DNS-01 challenge for the cert
 *
 * Per-service single-hostname certificates (rather than a shared SAN
 * cert) are intentional: GCP managed certs treat `domains` /
 * `dnsAuthorizations` as immutable, so adding a hostname to a shared
 * cert forces replace, which deadlocks against any CertificateMapEntry
 * still referencing the cert. Single-hostname certs isolate that risk
 * and match the per-service granularity used everywhere else.
 */
function provisionManagedHostname(
	parent: pulumi.ComponentResource,
	service: {
		name: string
		hostname: string
		zone: gcp.dns.ManagedZone
	},
	certMap: gcp.certificatemanager.CertificateMap,
	staticIp: gcp.compute.GlobalAddress,
	dependsOn: pulumi.Resource[],
): void {
	const { name, hostname, zone } = service

	const dnsAuth = new gcp.certificatemanager.DnsAuthorization(
		`${name}-dns-auth`,
		{
			name: `${name}-dns-auth`,
			location: 'global',
			domain: hostname,
		},
		{ parent, dependsOn },
	)

	const cert = new gcp.certificatemanager.Certificate(
		`${name}-cert`,
		{
			name: `${name}-cert`,
			location: 'global',
			scope: 'DEFAULT',
			managed: {
				domains: [hostname],
				dnsAuthorizations: [dnsAuth.id],
			},
		},
		{ parent, dependsOn },
	)

	new gcp.certificatemanager.CertificateMapEntry(
		`${name}-cert-map-entry`,
		{
			name: `${name}-cert-map-entry`,
			map: certMap.name,
			certificates: [cert.id],
			hostname,
		},
		{ parent, dependsOn },
	)

	new gcp.dns.RecordSet(
		`${name}-a-record`,
		{
			name: `${hostname}.`,
			managedZone: zone.name,
			type: 'A',
			ttl: 300,
			rrdatas: [staticIp.address],
		},
		{ parent, dependsOn },
	)

	new gcp.dns.RecordSet(
		`${name}-dns-auth-cname`,
		{
			name: dnsAuth.dnsResourceRecords.apply((r) => r[0].name),
			managedZone: zone.name,
			type: 'CNAME',
			ttl: 300,
			rrdatas: dnsAuth.dnsResourceRecords.apply((r) => [r[0].data]),
		},
		{ parent, dependsOn },
	)
}
