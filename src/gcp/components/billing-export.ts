import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
import { ApiService } from '../services/api.js'

export interface BillingExportComponentArgs {
	project: gcp.organizations.Project
	/** Forwarded to `ApiService` so the `bigquery.googleapis.com` enable
	 *  resource picks the correct `disableOnDestroy` policy. */
	environment: Environment
	/** Location for the BigQuery dataset. `asia-northeast1` (Tokyo) is
	 *  preferred over `asia-northeast2` (Osaka) because BigQuery editions
	 *  have broader feature parity in Tokyo and the export is read-only
	 *  for billing analysis (not co-located with workloads). */
	location?: pulumi.Input<string>
}

/**
 * BillingExportComponent provisions the BigQuery dataset that GCP Billing
 * Export writes to. The actual Console-side enable step (Billing →
 * Billing export → BigQuery export → choose this dataset) is NOT
 * Pulumi-managed because GCP does not expose a `BillingExportConfig`
 * resource — see `docs/runbooks/enable-billing-export.md` for the
 * one-time Console procedure.
 *
 * Why have this component at all if the Console does most of the work?
 *  - Codifies the dataset shape (name, location, description) so it
 *    survives accidental deletion via `pulumi up`.
 *  - Records the IAM principal that GCP's managed billing-export
 *    service uses to write into the dataset, so dataset permissions are
 *    a known quantity rather than something Console quietly grants.
 *  - Forces the BigQuery API to be enabled before anyone tries to
 *    enable the export, removing a class of "why doesn't this work"
 *    troubleshooting on the Console side.
 *
 * Standard, Detailed, and Pricing exports all land in the same dataset
 * but use distinct table names (`gcp_billing_export_v1_*`,
 * `gcp_billing_export_resource_v1_*`, `cloud_pricing_export`).
 */
export class BillingExportComponent extends pulumi.ComponentResource {
	public readonly dataset: gcp.bigquery.Dataset
	/** Fully-qualified dataset ID (`<project>:<dataset>`) for downstream
	 *  consumers (e.g., outputs surfaced in the prod stack). */
	public readonly datasetId: pulumi.Output<string>

	constructor(
		name: string,
		args: BillingExportComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:BillingExportComponent', name, args, opts)

		const { project, environment, location = 'asia-northeast1' } = args

		const apiService = new ApiService(project, environment)
		const enabledApis = apiService.enableApis(
			['bigquery.googleapis.com'],
			this,
		)

		this.dataset = new gcp.bigquery.Dataset(
			'billing-export',
			{
				datasetId: 'billing_export',
				friendlyName: 'GCP Billing Export',
				description:
					'Sink for GCP Billing Export — Standard, Detailed (resource-level), and Pricing data. ' +
					'See docs/runbooks/enable-billing-export.md for the Console-side enable procedure. ' +
					'Tables follow the pattern `gcp_billing_export_v1_<billing_account_id>`.',
				location,
				project: project.projectId,
				// Default table expiration is unset: billing data should be
				// retained indefinitely for historical analysis. Storage cost is
				// minimal (~MB/month for a single-project export).
			},
			{ parent: this, dependsOn: enabledApis },
		)

		// IAM grant for the managed billing-export service account.
		//
		// When billing export to BigQuery is enabled via the Console, GCP
		// uses a Google-managed service account to write to the dataset.
		// In most setups, the Console auto-grants the required role on
		// enable. This explicit binding makes the permission a Pulumi-
		// tracked invariant so:
		//   (a) drift caused by manual revocation is detected on next
		//       `pulumi preview`, and
		//   (b) the Console enable step succeeds on the first attempt
		//       without a permission-grant intermediate failure.
		//
		// The service account identifier `billing-export-bigquery@system.
		// gserviceaccount.com` is what GCP's Console actually grants on the
		// dataset when an operator enables Standard / Detailed / Pricing
		// export — confirmed empirically by inspecting dataset ACLs after a
		// Console-side enable. (The earlier guess of
		// `cloud-billing-export@system.gserviceaccount.com` resolved to a
		// non-existent principal, so the Pulumi binding was a silent no-op
		// before this fix.) If a future GCP change renames this principal,
		// the runbook's troubleshooting section walks through identifying
		// the actual SA from the dataset's effective ACL or Cloud Logging
		// audit trail.
		new gcp.bigquery.DatasetIamMember(
			'billing-export-writer',
			{
				datasetId: this.dataset.datasetId,
				project: project.projectId,
				role: 'roles/bigquery.dataEditor',
				member: 'serviceAccount:billing-export-bigquery@system.gserviceaccount.com',
			},
			{ parent: this },
		)

		this.datasetId = pulumi.interpolate`${project.projectId}:${this.dataset.datasetId}`

		this.registerOutputs({
			datasetId: this.datasetId,
		})
	}
}
