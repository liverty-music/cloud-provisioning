import * as cloudflare from '@pulumi/cloudflare'
import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
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
	environment: Environment
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

	constructor(
		name: string,
		args: NetworkComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:NetworkComponent', name, args, opts)

		const {
			// `region` and `regionName` were referenced by the staging Cloud
			// NAT block (now commented out per `refactor-unify-env-dispatch` D7).
			// Underscore-prefix marks them intentionally-unused until the NAT
			// block is uncommented at re-introduction.
			region: _region,
			regionName: _regionName,
			project,
			cloudflareConfig,
			environment,
			postmarkConfig,
		} = args

		const apiService = new ApiService(project, environment)
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

		// Cloud Router + Cloud NAT — currently disabled per
		// `refactor-unify-env-dispatch` D7 (kept as commented-out scaffolding
		// rather than deleted so re-introduction is grep-discoverable).
		// Re-introduction is expected when
		// EITHER (a) prod migrates to `privateClusterConfig.enablePrivateNodes:
		// true` (post-launch, per docs/PROD_BOOTSTRAP_DECISIONS.md D6 — NAT
		// becomes mandatory for private-node clusters to reach the internet),
		// OR (b) a staging stack is reintroduced.
		//
		// **Re-enable instructions** when the trigger fires:
		//   1. Restore the `if (environment === 'private')` / `'staging'` /
		//      whatever-the-trigger-env-is gate (or remove the gate if NAT
		//      becomes universal across all envs).
		//   2. If `Environment` type was narrowed in this change to drop
		//      `'staging'`, restore the union before re-enabling staging-gated
		//      NAT. See `src/config.ts`.
		//   3. Repopulate `senderAddressMap.staging` in `smtp.ts`,
		//      `baseDomainMap.staging` / `zitadelDomainMap.staging` in
		//      `zitadel/constants.ts`, `adminOrgIdMap.staging` in
		//      `zitadel/constants.ts` (discover via post-bootstrap Zitadel
		//      admin API).
		//   4. Uncomment the block below.
		//
		// TODO(refactor-unify-env-dispatch D7): re-enable when private-prod-
		// nodes flip OR staging reintroduction.
		//
		// if (environment === 'staging') {
		// 	this.router = new gcp.compute.Router(
		// 		`nat-router-${regionName}`,
		// 		{
		// 			name: `nat-router-${regionName}`,
		// 			network: this.network.id,
		// 			region: region,
		// 		},
		// 		{ parent: this },
		// 	)
		//
		// 	this.nat = new gcp.compute.RouterNat(
		// 		`nat-${regionName}`,
		// 		{
		// 			name: `nat-${regionName}`,
		// 			router: this.router.name,
		// 			region: region,
		// 			natIpAllocateOption: 'AUTO_ONLY',
		// 			sourceSubnetworkIpRangesToNat:
		// 				'ALL_SUBNETWORKS_ALL_IP_RANGES',
		// 			enableDynamicPortAllocation: true,
		// 			logConfig: {
		// 				enable: true,
		// 				filter: 'ERRORS_ONLY',
		// 			},
		// 		},
		// 		{ parent: this },
		// 	)
		// }

		// 4. Public DNS + Certificate Manager + shared Gateway resources.
		//
		// All public DNS lives in a single Cloudflare-authoritative zone
		// (`liverty-music.app`). Per `consolidate-public-dns-on-cloudflare`,
		// we no longer use Cloud DNS public zones nor NS subzone delegation —
		// the Cloudflare Registrar's apex-NS-lock constraint made the
		// subzone-delegation pattern a permanent dev/prod asymmetry. Google
		// Certificate Manager's DNS-01 authorization works against any DNS
		// provider, so ACME challenge CNAMEs live in Cloudflare too.
		//
		// Per-service shape (identical across envs and across services):
		//   • DnsAuthorization → emits the ACME challenge CNAME label
		//   • Certificate (single-hostname, managed.domains: [hostname])
		//   • CertificateMapEntry → binds Certificate to the shared CertMap
		//   • Cloudflare A record  → hostname → api-gateway-static-ip
		//   • Cloudflare CNAME     → ACME challenge resolution
		//
		// Env-specific hostname mapping:
		//   • dev:  web-app → `dev.liverty-music.app`         (subdomain '')
		//           backend-server → `api.dev.liverty-music.app`
		//           zitadel → `auth.dev.liverty-music.app`
		//   • prod: web-app → `liverty-music.app` (apex)      (subdomain '')
		//           backend-server → `api.liverty-music.app`
		//           zitadel → `auth.liverty-music.app`
		//
		// Pulumi resource names are env-agnostic per `refactor-unify-env-
		// dispatch` D8 — Pulumi stack URN handles env disambiguation.

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
		const protectInProd = environment === 'prod'

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
		// in GCP; A record + ACME CNAME in Cloudflare).
		for (const svc of SERVICES) {
			provisionManagedHostname(
				this,
				{
					name: svc.name,
					hostname: buildHostname(environment, svc.subdomain, tld),
					recordName: buildCloudflareRecordName(
						environment,
						svc.subdomain,
					),
				},
				certMap,
				staticIp,
				cloudflareProvider,
				cloudflareConfig.zoneId,
				certManagerApi,
				protectInProd,
			)
		}

		// Postmark Email DNS Records (Cloudflare for all envs).
		// dev hosts records under `mail.dev.liverty-music.app`; prod under
		// `mail.liverty-music.app`. Verification is via Postmark's DKIM check
		// against the public key in postmarkConfig.dkimPublicKey.
		const postmarkSubdomain = environment === 'prod' ? 'mail' : 'mail.dev'

		new cloudflare.DnsRecord(
			'postmark-dkim',
			{
				zoneId: cloudflareConfig.zoneId,
				name: `${postmarkConfig.dkimSelector}._domainkey.${postmarkSubdomain}`,
				type: 'TXT',
				content: `"k=rsa;p=${postmarkConfig.dkimPublicKey}"`,
				ttl: 300,
				comment:
					'Postmark DKIM settings (https://account.postmarkapp.com/signature_domains/)',
			},
			{ parent: this, provider: cloudflareProvider },
		)

		new cloudflare.DnsRecord(
			'postmark-return-path',
			{
				zoneId: cloudflareConfig.zoneId,
				name: `pm-bounces.${postmarkSubdomain}`,
				type: 'CNAME',
				content: 'pm.mtasv.net',
				ttl: 300,
				comment:
					'Postmark Return-Path settings (https://account.postmarkapp.com/signature_domains/)',
			},
			{ parent: this, provider: cloudflareProvider },
		)

		this.registerOutputs({
			networkName: this.network.name,
			sqlZoneName: this.sqlZone.name,
		})
	}
}

/**
 * Declarative catalog of externally-facing services. The `subdomain`
 * field is the prefix label inside the registrar TLD — empty string
 * denotes the apex-serving service (dev: zone is `dev.<tld>`, this is
 * the apex of that subdomain; prod: this is the registrar apex
 * `<tld>` itself).
 *
 * The `name` is the Pulumi resource-name prefix and MUST NOT change for
 * existing services — it is part of the stack URN.
 */
const SERVICES: ReadonlyArray<{
	name: string
	subdomain: string
}> = [
	{ name: 'backend-server', subdomain: 'api' },
	{ name: 'web-app', subdomain: '' },
	{ name: 'zitadel', subdomain: 'auth' },
	// Internal admin console — dev: admin.dev.liverty-music.app,
	// prod: admin.liverty-music.app. Served by its own k8s Deployment via a
	// dedicated HTTPRoute on this same shared gateway. See OpenSpec change
	// `add-admin-console`.
	{ name: 'admin-app', subdomain: 'admin' },
	// Admin API — dev: api.admin.dev.liverty-music.app,
	// prod: api.admin.liverty-music.app. The backend's dedicated admin Connect
	// server (second listener in the same Pod) exposed via server-admin-svc and
	// a dedicated HTTPRoute on this same shared gateway. See OpenSpec change
	// `split-admin-rpc-server`.
	{ name: 'admin-backend-server', subdomain: 'api.admin' },
]

/**
 * Resolve a service's full hostname FQDN based on env and subdomain.
 *
 * - **dev**: hostname is `<subdomain>.dev.<tld>`, or `dev.<tld>` when
 *   `subdomain === ''` (the dev web app sits at the dev "apex"
 *   `dev.liverty-music.app`).
 * - **prod**: hostname is `<subdomain>.<tld>`, or `<tld>` when
 *   `subdomain === ''` (the prod web app sits at the registrar apex
 *   `liverty-music.app`).
 */
function buildHostname(
	environment: Environment,
	subdomain: string,
	tld: string,
): string {
	if (environment === 'dev') {
		return subdomain ? `${subdomain}.dev.${tld}` : `dev.${tld}`
	}
	// prod
	return subdomain ? `${subdomain}.${tld}` : tld
}

/**
 * Resolve a service's Cloudflare DnsRecord `name` field — the label
 * relative to the Cloudflare zone (`liverty-music.app`).
 *
 * - **dev**: `<subdomain>.dev` or `dev` for the apex-serving service.
 * - **prod**: `<subdomain>` or `@` (Cloudflare's convention for the
 *   zone apex) for the apex-serving service.
 */
function buildCloudflareRecordName(
	environment: Environment,
	subdomain: string,
): string {
	if (environment === 'dev') {
		return subdomain ? `${subdomain}.dev` : 'dev'
	}
	// prod
	return subdomain || '@'
}

/**
 * Provision the per-hostname Pulumi resources that wire a service into
 * Google-managed TLS and Cloudflare-managed DNS:
 *
 *   - `<name>-dns-auth`           — Certificate Manager DnsAuthorization
 *   - `<name>-cert`               — single-hostname Google-managed Certificate
 *   - `<name>-cert-map-entry`     — binds the cert to the shared
 *                                    {@link gcp.certificatemanager.CertificateMap}
 *   - `<name>-a-record`           — Cloudflare A record pointing at
 *                                    {@link staticIp}
 *   - `<name>-dns-auth-cname`     — Cloudflare CNAME satisfying the
 *                                    ACME DNS-01 challenge for the cert
 *
 * Per-service single-hostname certificates (rather than a shared SAN
 * cert) are intentional: GCP managed certs treat `domains` /
 * `dnsAuthorizations` as immutable, so adding a hostname to a shared
 * cert forces replace, which deadlocks against any CertificateMapEntry
 * still referencing the cert. Single-hostname certs isolate that risk
 * and match the per-service granularity used everywhere else.
 *
 * When `protectInProd` is true, the GCP Certificate Manager resources
 * (DnsAuthorization, Certificate, CertificateMapEntry) and the
 * Cloudflare A record are flagged with `protect: true` to prevent
 * accidental `pulumi destroy` from taking the prod site down. The
 * ACME CNAME is intentionally not protected — it is regenerable from
 * the DnsAuthorization on re-issue.
 */
function provisionManagedHostname(
	parent: pulumi.ComponentResource,
	service: {
		name: string
		hostname: string
		recordName: string
	},
	certMap: gcp.certificatemanager.CertificateMap,
	staticIp: gcp.compute.GlobalAddress,
	cfProvider: cloudflare.Provider,
	cfZoneId: pulumi.Input<string>,
	dependsOn: pulumi.Resource[],
	protectInProd: boolean,
): void {
	const { name, hostname, recordName } = service

	const dnsAuth = new gcp.certificatemanager.DnsAuthorization(
		`${name}-dns-auth`,
		{
			name: `${name}-dns-auth`,
			location: 'global',
			domain: hostname,
		},
		{ parent, dependsOn, protect: protectInProd },
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
		{ parent, dependsOn, protect: protectInProd },
	)

	new gcp.certificatemanager.CertificateMapEntry(
		`${name}-cert-map-entry`,
		{
			name: `${name}-cert-map-entry`,
			map: certMap.name,
			certificates: [cert.id],
			hostname,
		},
		{ parent, dependsOn, protect: protectInProd },
	)

	new cloudflare.DnsRecord(
		`${name}-a-record`,
		{
			zoneId: cfZoneId,
			name: recordName,
			type: 'A',
			content: staticIp.address,
			ttl: 300,
			proxied: false,
			comment: `A record for ${hostname} → api-gateway-static-ip`,
		},
		{ parent, provider: cfProvider, protect: protectInProd },
	)

	// ACME DNS-01 challenge CNAME. Google emits `dnsResourceRecords[0]`
	// with `.name` as a fully-qualified label (trailing dot) and `.data`
	// as the challenge target (also FQDN with trailing dot). Cloudflare's
	// API expects the record `name` to be either the FQDN (no trailing
	// dot) or the subdomain-relative form; we strip the trailing dot
	// from both `name` and `content` for safety.
	new cloudflare.DnsRecord(
		`${name}-dns-auth-cname`,
		{
			zoneId: cfZoneId,
			name: dnsAuth.dnsResourceRecords.apply((r) =>
				r[0].name.replace(/\.$/, ''),
			),
			type: 'CNAME',
			content: dnsAuth.dnsResourceRecords.apply((r) =>
				r[0].data.replace(/\.$/, ''),
			),
			ttl: 300,
			proxied: false,
			comment: `ACME DNS-01 challenge for ${hostname}`,
		},
		{ parent, provider: cfProvider },
	)
}
