import * as cloudflare from '@pulumi/cloudflare'
import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { CloudflareConfig } from '../../cloudflare/config.js'
import type { Environment } from '../../config.js'
import { Roles } from '../services/iam.js'
import { buildCloudflareRecordName, buildHostname, tld } from './network.js'

export interface OrganizerMediaArgs {
	/** GCP project that owns the bucket. Its `.number` is required to derive
	 *  the Cloud CDN private-origin service account email. */
	project: gcp.organizations.Project
	/** Short brand identifier used in naming (e.g. `liverty-music`). */
	brandId: string
	/** Deployment environment — drives bucket name uniqueness, the media
	 *  hostname (dev → `media.dev.<tld>`, prod → `media.<tld>`), and optional
	 *  resource gating. */
	environment: Environment
	/** GCS multi-region or region. Osaka (`asia-northeast2`) is the project
	 *  default; GCS natively supports multi-region (`ASIA`) for higher
	 *  availability at negligible cost difference for small media assets.
	 *  Keeping it single-region (`asia-northeast2`) for cost parity with
	 *  the rest of the stack and simpler operational reasoning. */
	location: pulumi.Input<string>
	/** GCP Service Account email for the organizer-console-api workload.
	 *  Receives `roles/storage.objectAdmin` on THIS bucket only (not
	 *  project-level), following least-privilege design D7. */
	organizerConsoleApiSaEmail: pulumi.Input<string>
	/** GCP Service Account email for the media-consumer workload. Receives
	 *  `roles/storage.objectAdmin` bucket-scoped on BOTH the private originals
	 *  bucket (`organizer-media-internal`, to read uploaded originals) and the
	 *  served bucket (`organizer-media`, to write processed variants under
	 *  `cdn/{org}/{mediaId}/{variant}.webp`). No project-level storage role. */
	mediaConsumerSaEmail: pulumi.Input<string>
	/** Cloudflare provider config (API token + zone id). Reused to create the
	 *  `media.<publicDomain>` A record and the ACME DNS-01 challenge CNAME in
	 *  the single Cloudflare-authoritative zone (`liverty-music.app`), matching
	 *  `NetworkComponent`'s per-hostname wiring. */
	cloudflareConfig: CloudflareConfig
}

/**
 * OrganizerMediaComponent provisions a PRIVATE GCS bucket for organizer-authored
 * media and serves it through an external HTTPS Load Balancer backed by Cloud
 * CDN (a `BackendBucket` with `enableCdn`). The MVP stores one cover image per
 * Series; the bucket is deliberately NOT named "cover-images" so future
 * authoring media (image galleries, organizer logos, and similar) live in the
 * same bucket under distinct object-key prefixes rather than needing new
 * buckets.
 *
 * Why private-bucket + CDN and NOT `allUsers`:
 *   The organization enforces Domain Restricted Sharing (DRS), which rejects an
 *   `allUsers` bucket IAM binding with `Error 412`. Per design decision D7 the
 *   bucket stays PRIVATE and is fronted by an external HTTPS LB + Cloud CDN
 *   backend bucket. Cloud CDN reads the private origin using a Google-managed
 *   service account (`service-<PROJECT_NUMBER>@https-lb.iam.gserviceaccount.com`)
 *   which is a real org member, so the objectViewer grant is DRS-safe. See
 *   https://docs.cloud.google.com/cdn/docs/setting-up-cdn-with-bucket
 *   (private-origin / private bucket access section).
 *
 * Object key layout (owned by the backend, documented here for operators):
 *   `cdn/{organizer_id}/{media_id}`  (no file extension)
 *     - The `cdn/` prefix is explicitly routed by the LB URL map (`/cdn/*`
 *       → backend bucket). Currently ALL paths route to the backend bucket
 *       (the URL map `defaultService` also points there). If a non-public
 *       prefix (e.g. `internal/`) is introduced in the future, the URL map
 *       `defaultService` MUST be hardened to return 404 before that prefix
 *       is used, to prevent those objects from being publicly served via CDN.
 *   Each `media_id` is a fresh identifier per upload, so objects are immutable:
 *   a replaced image gets a NEW key, the served URL changes, and CDN caches
 *   never go stale. The backend writes objects with
 *   `Cache-Control: public, max-age=31536000, immutable` and deletes the prior
 *   object on replace / on series cancel (GCS has no reliable orphan signal for
 *   a lifecycle rule, so cleanup is application-driven).
 *
 * Serving model:
 *   - Backend validates type/size, then writes the object directly to the
 *     PRIVATE bucket using Workload Identity credentials (no signed URLs, no
 *     direct browser PUT — so no CORS config is required for writes).
 *   - Objects are served via Cloud CDN over the external HTTPS LB at
 *     `https://media.<publicDomain>/cdn/{organizer_id}/{media_id}`. The bucket
 *     is never reachable at `storage.googleapis.com` (no public IAM).
 *   - The served base URL is surfaced as the `cdnBaseUrl` output and injected
 *     into the `fan-api-config` ConfigMap as `ORGANIZER_MEDIA_CDN_BASE`
 *     (`https://media.<publicDomain>`) so the backend composes
 *     `{ORGANIZER_MEDIA_CDN_BASE}/cdn/{organizer_id}/{media_id}`.
 *
 * IAM:
 *   - `roles/storage.objectAdmin`  → organizer-console-api GSA (bucket-scoped)
 *     for backend writes.
 *   - `roles/storage.objectViewer` → the Cloud CDN private-origin service
 *     account `service-<PROJECT_NUMBER>@https-lb.iam.gserviceaccount.com`
 *     (bucket-scoped). NEVER `allUsers` — DRS would reject it.
 *
 * TLS / DNS:
 *   - Certificate is issued via Certificate Manager with a DNS-01 challenge
 *     satisfied through Cloudflare (identical to `NetworkComponent`'s
 *     per-hostname wiring), NOT a `ManagedSslCertificate`. The cert is attached
 *     to the TargetHttpsProxy via a `CertificateMap` (`certificateMap` field).
 *   - The Cloudflare A record for `media.<publicDomain>` is `proxied: false`
 *     (DNS-only) so the managed cert can provision and TLS terminates at the LB.
 *
 * CORS:
 *   - The NEW PRIVATE originals bucket (`organizer-media-internal`) has a CORS
 *     `PUT` rule allowing the organizer Web App origins to upload originals via
 *     a V4 signed URL (browser direct-upload). This bucket has NO LB/CDN, so
 *     its objects are unreachable except by IAM-authenticated readers.
 *   - The served bucket (`organizer-media`, this one) still has NO CORS: it is
 *     read via Cloud CDN over the external HTTPS LB and consumed by `<img>`
 *     tags (not subject to CORS), and writes to it are server-side (the
 *     media-consumer workload writes processed variants using Workload
 *     Identity credentials, no browser PUT).
 */
export class OrganizerMediaComponent extends pulumi.ComponentResource {
	/** GCS bucket name — stable after creation. */
	public readonly bucketName: pulumi.Output<string>
	/** Public serving base URL (`https://media.<publicDomain>`). The backend
	 *  composes object URLs as `{cdnBaseUrl}/cdn/{organizer_id}/{media_id}`.
	 *  Injected into the fan-api ConfigMap as `ORGANIZER_MEDIA_CDN_BASE`. */
	public readonly cdnBaseUrl: pulumi.Output<string>

	constructor(
		name: string,
		args: OrganizerMediaArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:OrganizerMediaComponent', name, args, opts)

		const {
			project,
			brandId,
			environment,
			location,
			organizerConsoleApiSaEmail,
			mediaConsumerSaEmail,
			cloudflareConfig,
		} = args

		const protectInProd = environment === 'prod'

		// Media hostname + Cloudflare record label, derived from the shared
		// helpers exported by NetworkComponent (buildHostname /
		// buildCloudflareRecordName) for the `media` subdomain:
		//   dev  → hostname `media.dev.liverty-music.app`, record `media.dev`
		//   prod → hostname `media.liverty-music.app`,     record `media`
		const hostname = buildHostname(environment, 'media', tld)
		const recordName = buildCloudflareRecordName(environment, 'media')
		const cdnBaseUrl = `https://${hostname}`

		// Bucket name must be globally unique across all GCP projects.
		// Pattern: `<brandId>-<environment>-organizer-media`
		// Example (prod): `liverty-music-prod-organizer-media`
		// Example (dev):  `liverty-music-dev-organizer-media`
		const bucketName = `${brandId}-${environment}-organizer-media`

		const bucket = new gcp.storage.Bucket(
			'organizer-media',
			{
				name: bucketName,
				project: project.projectId,
				location,
				// Uniform bucket-level access — disables per-object ACLs so that
				// only IAM bindings control access. Required for the Cloud CDN
				// private-origin service account to read objects via IAM.
				uniformBucketLevelAccess: true,
				// Standard storage class: media assets are served frequently and
				// are not archivable. Nearline/Coldline would add retrieval fees.
				storageClass: 'STANDARD',
				// Soft delete: disabled. Objects are immutable (a replaced image
				// gets a new `media_id` key and the backend deletes the prior
				// key), so GCS version history has no recovery value at MVP and
				// would only add storage cost.
				softDeletePolicy: {
					retentionDurationSeconds: 0,
				},
				// CORS: not configured — see class-level docstring.
			},
			{ parent: this },
		)

		this.bucketName = bucket.name

		// Backend write — organizer-console-api GSA gets full object control
		// on THIS bucket only (bucket-scoped binding, not project-level).
		// `objectAdmin` covers create + get + delete; the backend replaces a
		// cover by writing a new `media_id` key and deleting the old one.
		new gcp.storage.BucketIAMMember(
			'organizer-media-backend-write',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectAdmin,
				member: pulumi.interpolate`serviceAccount:${organizerConsoleApiSaEmail}`,
			},
			{ parent: this },
		)

		// PRIVATE originals bucket (`organizer-media-internal`). Holds uploaded
		// originals at key `{org}/{mediaId}`. Deliberately SEPARATE from the
		// served bucket — the served bucket's URL map routes `defaultService` to
		// the bucket, so any prefix there would be publicly CDN-served. This
		// bucket has NO LB/BackendBucket/URLMap/Cloudflare record, so its objects
		// are unreachable via CDN and only reachable by IAM-authenticated readers.
		// It is the CORS `PUT` target for browser direct-upload via a V4 signed URL.
		const internalBucket = new gcp.storage.Bucket(
			'organizer-media-internal',
			{
				name: `${brandId}-${environment}-organizer-media-internal`,
				project: project.projectId,
				location,
				// Uniform bucket-level access — disables per-object ACLs so that
				// only IAM bindings control access.
				uniformBucketLevelAccess: true,
				// Standard storage class: originals are read shortly after upload
				// by the media-consumer, then retained; Nearline/Coldline would
				// add retrieval fees for the immediate processing read.
				storageClass: 'STANDARD',
				// Soft delete: disabled. A replaced image gets a new `mediaId` key,
				// so GCS version history has no recovery value and would only add
				// storage cost.
				softDeletePolicy: {
					retentionDurationSeconds: 0,
				},
				// CORS: allow browser direct-upload via a V4 signed URL. The
				// organizer Web App issues a cross-origin `PUT` straight to this
				// bucket. Origins are the organizer console Web App origins (dev
				// additionally allows localhost + the dev hostname). The
				// `x-goog-content-length-range` header is what the signed URL uses
				// to bound the uploaded object size server-side.
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

		// media-consumer read/write on the PRIVATE originals bucket — reads the
		// uploaded original at `{org}/{mediaId}`. `objectAdmin` (not just viewer)
		// so it can also delete a processed original if the pipeline chooses to.
		// Bucket-scoped binding only; no project-level storage role. Aliased from
		// the old `organizer-media-internal-processor-write` logical name so the
		// media-processor → media-consumer rename adopts the existing binding.
		new gcp.storage.BucketIAMMember(
			'organizer-media-internal-consumer-write',
			{
				bucket: internalBucket.name,
				role: Roles.Storage.ObjectAdmin,
				member: pulumi.interpolate`serviceAccount:${mediaConsumerSaEmail}`,
			},
			{
				parent: this,
				aliases: [{ name: 'organizer-media-internal-processor-write' }],
			},
		)

		// organizer-console-api write on the PRIVATE originals bucket. The API
		// mints a V4 signed PUT URL (keyless, via IAM SignBlob) for the browser to
		// upload the original to `{org}/{mediaId}`; GCS authorizes that PUT against
		// the SIGNER (this GSA), so it needs object-create here. Bucket-scoped only.
		new gcp.storage.BucketIAMMember(
			'organizer-media-internal-api-write',
			{
				bucket: internalBucket.name,
				role: Roles.Storage.ObjectAdmin,
				member: pulumi.interpolate`serviceAccount:${organizerConsoleApiSaEmail}`,
			},
			{ parent: this },
		)

		// media-consumer write on the SERVED bucket — writes processed variants
		// at `cdn/{org}/{mediaId}/{variant}.webp`. Bucket-scoped binding only;
		// no project-level storage role. Aliased from the old
		// `organizer-media-processor-write` logical name so the rename adopts the
		// existing binding.
		new gcp.storage.BucketIAMMember(
			'organizer-media-consumer-write',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectAdmin,
				member: pulumi.interpolate`serviceAccount:${mediaConsumerSaEmail}`,
			},
			{
				parent: this,
				aliases: [{ name: 'organizer-media-processor-write' }],
			},
		)

		// Cloud CDN backend bucket over the PRIVATE bucket. `FORCE_CACHE_ALL`
		// per Google's private-bucket-access guidance: objects are immutable
		// (content-addressed by `media_id`), so aggressively cache everything at
		// the edge and let a replaced image produce a new key/URL.
		const backendBucket = new gcp.compute.BackendBucket(
			'organizer-media-backend-bucket',
			{
				name: `${brandId}-${environment}-organizer-media`,
				bucketName: bucket.name,
				enableCdn: true,
				cdnPolicy: {
					cacheMode: 'FORCE_CACHE_ALL',
					// 1 year — matches the backend's immutable Cache-Control.
					defaultTtl: 31536000,
					maxTtl: 31536000,
					clientTtl: 31536000,
				},
			},
			{ parent: this },
		)

		// Private-origin read for Cloud CDN. The LB reads the private bucket as
		// the Google-managed service account
		// `service-<PROJECT_NUMBER>@https-lb.iam.gserviceaccount.com`. This SA is
		// owned by Google (not the org's customer), so the org's Domain Restricted
		// Sharing policy REJECTS this grant (`Error 412`) unless DRS is relaxed.
		// The DRS override is set out-of-band, once, by an org admin
		// (`gcloud org-policies set-policy` allowAll on this project) — it is NOT
		// managed in Pulumi because org-policy admin is an org/folder-level
		// permission the deployer neither holds nor can self-grant. The bucket
		// itself stays PRIVATE (no `allUsers`); only this cache-fill SA is granted
		// read. The SA only exists after a BackendBucket exists, hence
		// `dependsOn: [backendBucket]`.
		// https://docs.cloud.google.com/cdn/docs/setting-up-cdn-with-bucket
		new gcp.storage.BucketIAMMember(
			'organizer-media-cdn-read',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectViewer,
				member: pulumi.interpolate`serviceAccount:service-${project.number}@https-lb.iam.gserviceaccount.com`,
			},
			{ parent: this, dependsOn: [backendBucket] },
		)

		// Global external IPv4 for the media LB (separate from the shared
		// api-gateway static IP; this LB fronts only the CDN backend bucket).
		const address = new gcp.compute.GlobalAddress(
			'organizer-media-lb-ip',
			{
				name: `${brandId}-${environment}-organizer-media-lb-ip`,
				addressType: 'EXTERNAL',
				ipVersion: 'IPV4',
			},
			{ parent: this, protect: protectInProd },
		)

		// Cloudflare provider — mirrors NetworkComponent by design: each
		// component constructs its own provider instance from `cloudflareConfig`
		// rather than sharing a global one (Pulumi providers are cheap to
		// instantiate and sharing would create a cross-component dependency).
		const cloudflareProvider = new cloudflare.Provider(
			'organizer-media-cloudflare-provider',
			{ apiToken: cloudflareConfig.apiToken },
			{ parent: this },
		)

		// TLS via Certificate Manager + DNS-01 through Cloudflare (NOT a
		// ManagedSslCertificate) — identical shape to NetworkComponent's
		// `provisionManagedHostname`.
		const dnsAuth = new gcp.certificatemanager.DnsAuthorization(
			'organizer-media-dns-auth',
			{
				name: 'organizer-media-dns-auth',
				location: 'global',
				domain: hostname,
			},
			{ parent: this, protect: protectInProd },
		)

		const cert = new gcp.certificatemanager.Certificate(
			'organizer-media-cert',
			{
				name: 'organizer-media-cert',
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
			'organizer-media-cert-map',
			{ name: 'organizer-media-cert-map' },
			{ parent: this, protect: protectInProd },
		)

		new gcp.certificatemanager.CertificateMapEntry(
			'organizer-media-cert-map-entry',
			{
				name: 'organizer-media-cert-map-entry',
				map: certMap.name,
				certificates: [cert.id],
				hostname,
			},
			{ parent: this, protect: protectInProd },
		)

		// URL map: BOTH the top-level `defaultService` AND the pathMatcher's
		// `defaultService` point to the CDN backend bucket, so all paths
		// (including any future `internal/` prefix) currently route to the
		// bucket. The explicit `/cdn/*` path rule is retained for clarity and
		// future specificity, but it is redundant with the default today.
		// NOTE: if a non-public object prefix (e.g. `internal/`) is introduced,
		// the `defaultService` here MUST be changed to a 404-returning backend
		// (or a Cloud Armor policy added) before the prefix is written to the
		// bucket — otherwise those objects will be publicly served via CDN.
		const urlMap = new gcp.compute.URLMap(
			'organizer-media-url-map',
			{
				name: 'organizer-media-url-map',
				defaultService: backendBucket.id,
				hostRules: [
					{
						hosts: [hostname],
						pathMatcher: 'media',
					},
				],
				pathMatchers: [
					{
						name: 'media',
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

		// TargetHttpsProxy references the URL map and the Certificate Manager
		// map (via `certificateMap`, NOT `sslCertificates`).
		const httpsProxy = new gcp.compute.TargetHttpsProxy(
			'organizer-media-https-proxy',
			{
				name: 'organizer-media-https-proxy',
				urlMap: urlMap.id,
				certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${certMap.id}`,
			},
			{ parent: this },
		)

		// Global forwarding rule: :443 → target HTTPS proxy → the global IP.
		new gcp.compute.GlobalForwardingRule(
			'organizer-media-forwarding-rule',
			{
				name: 'organizer-media-forwarding-rule',
				target: httpsProxy.id,
				ipAddress: address.address,
				portRange: '443',
				loadBalancingScheme: 'EXTERNAL_MANAGED',
			},
			{ parent: this, protect: protectInProd },
		)

		// Cloudflare A record for `media.<publicDomain>` → the media LB IP.
		// `proxied: false` (DNS-only) so the Google-managed cert can provision
		// and TLS terminates at the LB.
		new cloudflare.DnsRecord(
			'organizer-media-a-record',
			{
				zoneId: cloudflareConfig.zoneId,
				name: recordName,
				type: 'A',
				content: address.address,
				ttl: 300,
				proxied: false,
				comment: `A record for ${hostname} → organizer-media LB`,
			},
			{
				parent: this,
				provider: cloudflareProvider,
				protect: protectInProd,
			},
		)

		// ACME DNS-01 challenge CNAME — copy the exact shape from
		// NetworkComponent's `provisionManagedHostname`: strip the trailing dot
		// from both the emitted `.name` and `.data`.
		new cloudflare.DnsRecord(
			'organizer-media-dns-auth-cname',
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
