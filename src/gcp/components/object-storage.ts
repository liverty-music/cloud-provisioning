import * as cloudflare from '@pulumi/cloudflare'
import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { CloudflareConfig } from '../../cloudflare/config.js'
import type { Environment } from '../../config.js'
import { Roles } from '../services/iam.js'
import { buildCloudflareRecordName, buildHostname, tld } from './network.js'

export interface ObjectStorageArgs {
	/** GCP project that owns the buckets. Its `.number` is required to derive
	 *  the Cloud CDN private-origin service account email. */
	project: gcp.organizations.Project
	/** Short brand identifier used in naming (e.g. `liverty-music`). */
	brandId: string
	/** Deployment environment — drives bucket name uniqueness, the CDN
	 *  hostname (dev → `cdn.dev.<tld>`, prod → `cdn.<tld>`), and resource
	 *  protection. */
	environment: Environment
	/** GCS location. Single-region Osaka (`asia-northeast2`) for cost parity
	 *  with the rest of the stack. */
	location: pulumi.Input<string>
	/** GCP Service Account email for the organizer-console-api workload.
	 *  Receives `roles/storage.objectAdmin` on BOTH buckets (bucket-scoped,
	 *  not project-level): it writes to the served bucket and signs the V4
	 *  upload URL for the internal bucket. */
	organizerConsoleApiSaEmail: pulumi.Input<string>
	/** GCP Service Account emails of the series image consumer workload, keyed
	 *  by a stable label used in the IAM binding logical names. Each receives
	 *  `roles/storage.objectAdmin` bucket-scoped on BOTH the internal bucket
	 *  (to read uploaded originals) and the served bucket (to write processed
	 *  variants under `cdn/{org}/{id}/{variant}.webp`). A map rather than a
	 *  single email so the old `media-consumer` and the new
	 *  `series-image-consumer` GSAs can both write during the rename; removing
	 *  one key later leaves the other's binding URN unchanged. */
	seriesImageConsumerSaEmails: Record<string, pulumi.Input<string>>
	/** GCP Service Account email for the admin-console-api workload. Receives
	 *  `roles/storage.objectUser` bucket-scoped on BOTH buckets so the admin
	 *  `OrganizerService.Delete` can remove a deleted Organizer's originals and
	 *  served variants. No project-level storage role. */
	adminConsoleApiSaEmail: pulumi.Input<string>
	/** Cloudflare provider config (API token + zone id). Used to create the
	 *  `cdn.<publicDomain>` A record and the ACME DNS-01 challenge CNAME in
	 *  the Cloudflare-authoritative zone (`liverty-music.app`), matching
	 *  `NetworkComponent`'s per-hostname wiring. */
	cloudflareConfig: CloudflareConfig
}

/**
 * ObjectStorageComponent provisions the application's object storage: a
 * PRIVATE served bucket (`<brandId>-<env>`) fronted by an external HTTPS Load
 * Balancer with Cloud CDN at `cdn.<publicDomain>`, and a PRIVATE internal
 * bucket (`<brandId>-<env>-internal`) for uploaded originals that is never
 * served. Successor of `OrganizerMediaComponent` with identical behavior;
 * only the names differ (bucket, hostname, logical names). Both components
 * coexist until objects are copied and the workloads switch over.
 *
 * Why private bucket + CDN and NOT `allUsers`:
 *   The organization enforces Domain Restricted Sharing (DRS), which rejects an
 *   `allUsers` bucket IAM binding with `Error 412`. The served bucket stays
 *   PRIVATE and Cloud CDN reads it as the Google-managed service account
 *   `service-<PROJECT_NUMBER>@https-lb.iam.gserviceaccount.com`. See
 *   https://docs.cloud.google.com/cdn/docs/setting-up-cdn-with-bucket
 *   (private-origin / private bucket access section).
 *
 * Object key layout (owned by the backend, documented here for operators):
 *   - internal bucket: `{organizer_id}/{id}` (uploaded original)
 *   - served bucket:   `cdn/{organizer_id}/{id}/{variant}.webp`
 *   Each id is fresh per upload, so objects are immutable: a replaced image
 *   gets a NEW key and CDN caches never go stale. The URL map currently routes
 *   ALL paths of the served bucket to the CDN; a non-public prefix MUST NOT be
 *   written there without first hardening `defaultService` to return 404.
 *
 * Serving model:
 *   - The served base URL is surfaced as the `cdnBaseUrl` output and injected
 *     into the backend ConfigMaps as `CDN_BASE_URL` (`https://cdn.<publicDomain>`).
 *
 * TLS / DNS:
 *   - Certificate Manager certificate with a DNS-01 challenge satisfied
 *     through Cloudflare (same shape as `NetworkComponent`), attached to the
 *     TargetHttpsProxy via a `CertificateMap`.
 *   - The Cloudflare A record is `proxied: false` (DNS-only) so the managed
 *     cert can provision and TLS terminates at the LB.
 *
 * CORS:
 *   - The internal bucket has a CORS `PUT` rule for the organizer Web App
 *     origins (browser direct-upload via a V4 signed URL).
 *   - The served bucket has NO CORS: it is read by `<img>` tags via Cloud CDN
 *     and written server-side only.
 */
export class ObjectStorageComponent extends pulumi.ComponentResource {
	/** Served GCS bucket name — stable after creation. */
	public readonly bucketName: pulumi.Output<string>
	/** Public serving base URL (`https://cdn.<publicDomain>`). Injected into
	 *  the backend ConfigMaps as `CDN_BASE_URL`. */
	public readonly cdnBaseUrl: pulumi.Output<string>

	constructor(
		name: string,
		args: ObjectStorageArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:ObjectStorageComponent', name, args, opts)

		const {
			project,
			brandId,
			environment,
			location,
			organizerConsoleApiSaEmail,
			seriesImageConsumerSaEmails,
			adminConsoleApiSaEmail,
			cloudflareConfig,
		} = args

		const protectInProd = environment === 'prod'

		// CDN hostname + Cloudflare record label:
		//   dev  → hostname `cdn.dev.liverty-music.app`, record `cdn.dev`
		//   prod → hostname `cdn.liverty-music.app`,     record `cdn`
		const hostname = buildHostname(environment, 'cdn', tld)
		const recordName = buildCloudflareRecordName(environment, 'cdn')
		const cdnBaseUrl = `https://${hostname}`

		// Bucket names are globally unique across all GCP projects.
		// Pattern: `<brandId>-<environment>` (e.g. `liverty-music-prod`).
		const bucketName = `${brandId}-${environment}`

		const bucket = new gcp.storage.Bucket(
			'object-storage',
			{
				name: bucketName,
				project: project.projectId,
				location,
				// Uniform bucket-level access — only IAM bindings control access.
				// Required for the Cloud CDN private-origin service account.
				uniformBucketLevelAccess: true,
				// Served frequently; Nearline/Coldline would add retrieval fees.
				storageClass: 'STANDARD',
				// Soft delete disabled: objects are immutable (new key per
				// upload), so version history has no recovery value.
				softDeletePolicy: {
					retentionDurationSeconds: 0,
				},
				// CORS: not configured — see class-level docstring.
			},
			{ parent: this },
		)

		this.bucketName = bucket.name

		// organizer-console-api write on the served bucket (bucket-scoped).
		new gcp.storage.BucketIAMMember(
			'object-storage-backend-write',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectAdmin,
				member: pulumi.interpolate`serviceAccount:${organizerConsoleApiSaEmail}`,
			},
			{ parent: this },
		)

		// Internal bucket for uploaded originals at `{org}/{id}`. Deliberately
		// SEPARATE from the served bucket (whose URL map serves every prefix):
		// it has NO LB/BackendBucket/URLMap/DNS record, so its objects are only
		// reachable by IAM-authenticated readers. It is the CORS `PUT` target
		// for browser direct-upload via a V4 signed URL.
		const internalBucket = new gcp.storage.Bucket(
			'object-storage-internal',
			{
				name: `${brandId}-${environment}-internal`,
				project: project.projectId,
				location,
				uniformBucketLevelAccess: true,
				// Originals are read right after upload by the series image
				// consumer; Nearline/Coldline would add retrieval fees.
				storageClass: 'STANDARD',
				softDeletePolicy: {
					retentionDurationSeconds: 0,
				},
				// CORS: browser direct-upload via a V4 signed URL from the
				// organizer Web App origins (dev also allows localhost and the
				// dev hostname). `x-goog-content-length-range` bounds the
				// uploaded object size server-side.
				cors: [
					{
						methods: ['PUT'],
						origins:
							environment === 'dev'
								? [
										'https://organizer.liverty-music.app',
										'http://localhost:9100',
										'https://organizer.dev.liverty-music.app',
									]
								: ['https://organizer.liverty-music.app'],
						responseHeaders: [
							'Content-Type',
							'x-goog-content-length-range',
						],
						maxAgeSeconds: 3600,
					},
				],
			},
			{ parent: this },
		)

		// Series image consumer read/write on BOTH buckets: reads the original
		// from the internal bucket and writes processed variants to the served
		// bucket. `objectAdmin` so it can also delete a processed original.
		// Bucket-scoped only; no project-level storage role.
		for (const [key, email] of Object.entries(
			seriesImageConsumerSaEmails,
		)) {
			new gcp.storage.BucketIAMMember(
				`object-storage-internal-${key}-write`,
				{
					bucket: internalBucket.name,
					role: Roles.Storage.ObjectAdmin,
					member: pulumi.interpolate`serviceAccount:${email}`,
				},
				{ parent: this },
			)
			new gcp.storage.BucketIAMMember(
				`object-storage-${key}-write`,
				{
					bucket: bucket.name,
					role: Roles.Storage.ObjectAdmin,
					member: pulumi.interpolate`serviceAccount:${email}`,
				},
				{ parent: this },
			)
		}

		// organizer-console-api write on the internal bucket. GCS authorizes a
		// V4 signed PUT against the SIGNER (this GSA, keyless via IAM
		// SignBlob), so it needs object-create here. Bucket-scoped only.
		new gcp.storage.BucketIAMMember(
			'object-storage-internal-api-write',
			{
				bucket: internalBucket.name,
				role: Roles.Storage.ObjectAdmin,
				member: pulumi.interpolate`serviceAccount:${organizerConsoleApiSaEmail}`,
			},
			{ parent: this },
		)

		// admin-console-api delete on BOTH buckets — the admin
		// `OrganizerService.Delete` removes a deleted Organizer's originals and
		// served variants. `objectUser` covers list + get + delete without
		// bucket IAM rights. Bucket-scoped only.
		new gcp.storage.BucketIAMMember(
			'object-storage-admin-delete',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectUser,
				member: pulumi.interpolate`serviceAccount:${adminConsoleApiSaEmail}`,
			},
			{ parent: this },
		)
		new gcp.storage.BucketIAMMember(
			'object-storage-internal-admin-delete',
			{
				bucket: internalBucket.name,
				role: Roles.Storage.ObjectUser,
				member: pulumi.interpolate`serviceAccount:${adminConsoleApiSaEmail}`,
			},
			{ parent: this },
		)

		// Cloud CDN backend bucket over the private served bucket.
		// `FORCE_CACHE_ALL` per Google's private-bucket-access guidance: objects
		// are immutable, so cache everything at the edge.
		const backendBucket = new gcp.compute.BackendBucket(
			'object-storage-backend-bucket',
			{
				name: bucketName,
				bucketName: bucket.name,
				enableCdn: true,
				cdnPolicy: {
					cacheMode: 'FORCE_CACHE_ALL',
					// 1 year — matches the backend's immutable Cache-Control.
					// No maxTtl: with FORCE_CACHE_ALL "the TTL is always set to
					// the default TTL; you can't set a max TTL" (Cloud CDN TTL
					// overrides), and the API returning 0 for it made every
					// `pulumi up` report a diff.
					defaultTtl: 31536000,
					clientTtl: 31536000,
				},
			},
			{ parent: this },
		)

		// Private-origin read for Cloud CDN as the Google-managed
		// `service-<PROJECT_NUMBER>@https-lb.iam.gserviceaccount.com`. DRS
		// rejects this grant unless relaxed; the project-level DRS override is
		// set out-of-band by an org admin (see `OrganizerMediaComponent`). The
		// SA only exists after a BackendBucket exists, hence `dependsOn`.
		new gcp.storage.BucketIAMMember(
			'object-storage-cdn-read',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectViewer,
				member: pulumi.interpolate`serviceAccount:service-${project.number}@https-lb.iam.gserviceaccount.com`,
			},
			{ parent: this, dependsOn: [backendBucket] },
		)

		// Global external IPv4 for the CDN LB (separate from the shared
		// api-gateway static IP; this LB fronts only the CDN backend bucket).
		const address = new gcp.compute.GlobalAddress(
			'object-storage-lb-ip',
			{
				name: `${brandId}-${environment}-cdn-lb-ip`,
				addressType: 'EXTERNAL',
				ipVersion: 'IPV4',
			},
			{ parent: this, protect: protectInProd },
		)

		// Each component constructs its own Cloudflare provider from
		// `cloudflareConfig` (mirrors NetworkComponent).
		const cloudflareProvider = new cloudflare.Provider(
			'object-storage-cloudflare-provider',
			{ apiToken: cloudflareConfig.apiToken },
			{ parent: this },
		)

		// TLS via Certificate Manager + DNS-01 through Cloudflare.
		const dnsAuth = new gcp.certificatemanager.DnsAuthorization(
			'object-storage-dns-auth',
			{
				name: 'object-storage-dns-auth',
				location: 'global',
				domain: hostname,
			},
			{ parent: this, protect: protectInProd },
		)

		const cert = new gcp.certificatemanager.Certificate(
			'object-storage-cert',
			{
				name: 'object-storage-cert',
				location: 'global',
				scope: 'DEFAULT',
				managed: {
					domains: [hostname],
					dnsAuthorizations: [dnsAuth.id],
				},
			},
			{ parent: this, protect: protectInProd },
		)

		const certMap = new gcp.certificatemanager.CertificateMap(
			'object-storage-cert-map',
			{ name: 'object-storage-cert-map' },
			{ parent: this, protect: protectInProd },
		)

		new gcp.certificatemanager.CertificateMapEntry(
			'object-storage-cert-map-entry',
			{
				name: 'object-storage-cert-map-entry',
				map: certMap.name,
				certificates: [cert.id],
				hostname,
			},
			{ parent: this, protect: protectInProd },
		)

		// URL map: the top-level and the pathMatcher `defaultService` both point
		// to the CDN backend bucket, so ALL paths are served. The `/cdn/*` rule
		// is kept for clarity and future specificity. If a non-public prefix is
		// ever written to the served bucket, change `defaultService` to a
		// 404-returning backend first.
		const urlMap = new gcp.compute.URLMap(
			'object-storage-url-map',
			{
				name: 'object-storage-url-map',
				defaultService: backendBucket.id,
				hostRules: [
					{
						hosts: [hostname],
						pathMatcher: 'cdn',
					},
				],
				pathMatchers: [
					{
						name: 'cdn',
						defaultService: backendBucket.id,
						pathRules: [
							{
								paths: ['/cdn/*'],
								service: backendBucket.id,
							},
						],
					},
				],
			},
			{ parent: this },
		)

		const httpsProxy = new gcp.compute.TargetHttpsProxy(
			'object-storage-https-proxy',
			{
				name: 'object-storage-https-proxy',
				urlMap: urlMap.id,
				certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${certMap.id}`,
			},
			{ parent: this },
		)

		// Global forwarding rule: :443 → target HTTPS proxy → the global IP.
		new gcp.compute.GlobalForwardingRule(
			'object-storage-forwarding-rule',
			{
				name: 'object-storage-forwarding-rule',
				target: httpsProxy.id,
				ipAddress: address.address,
				portRange: '443',
				loadBalancingScheme: 'EXTERNAL_MANAGED',
			},
			{ parent: this, protect: protectInProd },
		)

		// Cloudflare A record for `cdn.<publicDomain>` → the CDN LB IP.
		// `proxied: false` so the managed cert can provision and TLS
		// terminates at the LB.
		new cloudflare.DnsRecord(
			'object-storage-a-record',
			{
				zoneId: cloudflareConfig.zoneId,
				name: recordName,
				type: 'A',
				content: address.address,
				ttl: 300,
				proxied: false,
				comment: `A record for ${hostname} → object-storage LB`,
			},
			{
				parent: this,
				provider: cloudflareProvider,
				protect: protectInProd,
			},
		)

		// ACME DNS-01 challenge CNAME — strip the trailing dot from both the
		// emitted `.name` and `.data` (same shape as NetworkComponent).
		new cloudflare.DnsRecord(
			'object-storage-dns-auth-cname',
			{
				zoneId: cloudflareConfig.zoneId,
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
			{ parent: this, provider: cloudflareProvider },
		)

		this.cdnBaseUrl = pulumi.output(cdnBaseUrl)

		this.registerOutputs({
			bucketName: this.bucketName,
			cdnBaseUrl: this.cdnBaseUrl,
		})
	}
}
