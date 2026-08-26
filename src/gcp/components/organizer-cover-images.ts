import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
import { Roles } from '../services/iam.js'

export interface OrganizerCoverImagesArgs {
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
 * OrganizerCoverImagesComponent provisions a GCS bucket for organizer-uploaded
 * cover images (one per Series at MVP).
 *
 * Serving model:
 *   - Backend validates type/size, then writes the object directly to the
 *     bucket using Workload Identity credentials (no signed URLs, no direct
 *     browser PUT — so no CORS config is required for writes).
 *   - Objects are served publicly via
 *     `https://storage.googleapis.com/<bucket>/<object>`.
 *   - The bucket name is surfaced as the `bucketName` output and injected
 *     into the `fan-api-config` ConfigMap as `ORGANIZER_COVER_IMAGE_BUCKET`
 *     so the organizer-console-api workload can construct the serving URL.
 *
 * IAM:
 *   - `roles/storage.objectAdmin` → organizer-console-api GSA (bucket-scoped).
 *   - `roles/storage.objectViewer` → allUsers (public read for serving).
 *
 * CORS:
 *   Not configured. Uploads are server-side (backend RPC → GCS write); the
 *   frontend never issues a cross-origin PUT directly to the bucket. The
 *   public serving URL is consumed by `<img>` tags, which are same-origin
 *   from the browser's perspective (CORS does not apply to `<img>` src). If
 *   a future change introduces direct browser upload or XHR fetch of objects,
 *   add a CORS block at that time.
 */
export class OrganizerCoverImagesComponent extends pulumi.ComponentResource {
	/** GCS bucket name — stable after creation; suitable for persisting in
	 *  the database as the base URL prefix for served objects. */
	public readonly bucketName: pulumi.Output<string>

	constructor(
		name: string,
		args: OrganizerCoverImagesArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super(
			'gcp:liverty-music:OrganizerCoverImagesComponent',
			name,
			args,
			opts,
		)

		const {
			project,
			brandId,
			environment,
			location,
			organizerConsoleApiSaEmail,
		} = args

		// Bucket name must be globally unique across all GCP projects.
		// Pattern: `<brandId>-<environment>-organizer-cover-images`
		// Example (prod): `liverty-music-prod-organizer-cover-images`
		// Example (dev):  `liverty-music-dev-organizer-cover-images`
		const bucketName = `${brandId}-${environment}-organizer-cover-images`

		const bucket = new gcp.storage.Bucket(
			'organizer-cover-images',
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
				// Soft delete: disabled. Cover image objects are replaced in-place
				// when an organizer re-uploads; retaining deleted versions adds
				// storage cost with no recovery value at MVP (the source of truth
				// is the organizer upload, not GCS history).
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
		// Requires uniform bucket-level access (set above).
		new gcp.storage.BucketIAMMember(
			'organizer-cover-images-public-read',
			{
				bucket: bucket.name,
				role: Roles.Storage.ObjectViewer,
				member: 'allUsers',
			},
			{ parent: this },
		)

		// Backend write — organizer-console-api GSA gets full object control
		// on THIS bucket only (bucket-scoped binding, not project-level).
		// `objectAdmin` covers create + replace + delete + get; the backend
		// may need to replace a previously uploaded cover image.
		new gcp.storage.BucketIAMMember(
			'organizer-cover-images-backend-write',
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
