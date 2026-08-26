import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
import { Roles } from '../services/iam.js'

export interface OrganizerMediaArgs {
	/** GCP project that owns the bucket. */
	project: gcp.organizations.Project
	/** Short brand identifier used in naming (e.g. `liverty-music`). */
	brandId: string
	/** Deployment environment — drives bucket name uniqueness and optional
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
	/** When `false` (dev shutdown mode), this component is skipped by the
	 *  caller and never constructed. The gate lives in `gcp/index.ts`;
	 *  this field is accepted here only for documentation clarity. */
	workloadEnabled: boolean
}

/**
 * OrganizerMediaComponent provisions a single GCS bucket for organizer-authored
 * media. The MVP stores one cover image per Series; the bucket is deliberately
 * NOT named "cover-images" so future authoring media (image galleries, organizer
 * logos, and similar) live in the same bucket under distinct object-key
 * prefixes rather than needing new buckets.
 *
 * Object key layout (owned by the backend, documented here for operators):
 *   `<entity>/<entityId>/<purpose>/<contentHash>.<ext>`
 *     - MVP cover:      `series/<seriesId>/cover/<sha256>.<ext>`
 *     - future gallery: `series/<seriesId>/gallery/<sha256>.<ext>`
 *     - future logo:    `organizer/<organizerId>/logo/<sha256>.<ext>`
 *   Content-addressed filenames (sha256 of the bytes) make each object
 *   immutable: a replaced image gets a NEW key, so the served URL changes and
 *   caches never go stale. The backend writes objects with
 *   `Cache-Control: public, max-age=31536000, immutable` and deletes the prior
 *   object on replace / on series cancel (GCS has no reliable orphan signal for
 *   a lifecycle rule, so cleanup is application-driven). A content hash also
 *   satisfies the enumeration-resistance naming guidance. Object-key volume here
 *   is far below the ~1,000 writes/s hotspot threshold, so the semi-sequential
 *   `series/<uuidv7>/` prefix is fine and the browsable layout is preferred over
 *   a randomized prefix.
 *
 * Serving model:
 *   - Backend validates type/size, then writes the object directly to the
 *     bucket using Workload Identity credentials (no signed URLs, no direct
 *     browser PUT — so no CORS config is required for writes).
 *   - Objects are served publicly via
 *     `https://storage.googleapis.com/<bucket>/<object>`.
 *   - Public read is acceptable because MVP media backs PUBLIC concerts (already
 *     public information). If/when private or UNLISTED media ships, that media
 *     should move to signed URLs rather than `allUsers` (per GCS guidance for
 *     access-controlled user media) — do NOT make private media public here.
 *   - The bucket name is surfaced as the `bucketName` output and injected into
 *     the `fan-api-config` ConfigMap as `ORGANIZER_MEDIA_BUCKET` so the
 *     organizer-console-api workload can construct the serving URL.
 *
 * IAM:
 *   - `roles/storage.objectAdmin` → organizer-console-api GSA (bucket-scoped).
 *   - `roles/storage.objectViewer` → allUsers (public read for serving).
 *
 * CORS:
 *   Not configured. Uploads are server-side (backend RPC → GCS write); the
 *   frontend never issues a cross-origin PUT directly to the bucket. The public
 *   serving URL is consumed by `<img>` tags, which are not subject to CORS. If a
 *   future change introduces direct browser upload or XHR fetch of objects, add
 *   a CORS block at that time.
 */
export class OrganizerMediaComponent extends pulumi.ComponentResource {
	/** GCS bucket name — stable after creation; suitable for persisting in
	 *  the database as the base URL prefix for served objects. */
	public readonly bucketName: pulumi.Output<string>

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
		} = args

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
				// only IAM bindings control access. Required for `allUsers` public
				// serving via IAM (the legacy ACL model must be disabled when
				// uniform access is enabled).
				uniformBucketLevelAccess: true,
				// Standard storage class: media assets are served frequently and
				// are not archivable. Nearline/Coldline would add retrieval fees.
				storageClass: 'STANDARD',
				// Soft delete: disabled. Objects are content-addressed and replaced
				// by writing a new key (the backend deletes the prior key), so GCS
				// version history has no recovery value at MVP and would only add
				// storage cost.
				softDeletePolicy: {
					retentionDurationSeconds: 0,
				},
				// CORS: not configured — see class-level docstring.
			},
			{ parent: this },
		)

		this.bucketName = bucket.name

		// Public read — all objects are publicly accessible via the stable
		// HTTPS URL `https://storage.googleapis.com/<bucket>/<object>`.
		// `allUsers` is the GCP convention for unauthenticated public access.
		// Requires uniform bucket-level access (set above). MVP media backs
		// PUBLIC concerts; private/UNLISTED media must use signed URLs instead.
		new gcp.storage.BucketIAMMember(
			'organizer-media-public-read',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectViewer,
				member: 'allUsers',
			},
			{ parent: this },
		)

		// Backend write — organizer-console-api GSA gets full object control
		// on THIS bucket only (bucket-scoped binding, not project-level).
		// `objectAdmin` covers create + get + delete; the backend replaces a
		// cover by writing a new content-addressed key and deleting the old one.
		new gcp.storage.BucketIAMMember(
			'organizer-media-backend-write',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectAdmin,
				member: pulumi.interpolate`serviceAccount:${organizerConsoleApiSaEmail}`,
			},
			{ parent: this },
		)

		this.registerOutputs({
			bucketName: this.bucketName,
		})
	}
}
