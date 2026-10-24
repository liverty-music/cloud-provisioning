import { readFileSync } from 'node:fs'
import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { IamService, Roles } from '../services/iam.js'

export interface AnalyticsWarehouseComponentArgs {
	project: gcp.organizations.Project
	/** Location of every analytics dataset and of the analytics log bucket.
	 *  It must match `billing_export` (asia-northeast1): BigQuery joins only
	 *  datasets in the job's location, and the billing dataset cannot move. */
	location?: string
}

/** PostHog's own service account, which impersonates `posthog-export`
 *  (`posthog.com/docs/data-pipelines/batch-exports/bigquery`). */
const POSTHOG_BATCH_EXPORTS_SA =
	'posthog-batch-exports@posthog-external.iam.gserviceaccount.com'

/** PostHog checks for `posthog:<organization id>` in the impersonated
 *  account's description before it exports. */
const POSTHOG_ORGANIZATION_ID = '019e7b58-75ff-0000-79de-62f6f9ec2075'

/** The label every analytics log line carries (backend `pkg/analyticslog`).
 *  A new topic needs no change here. */
const ANALYTICS_LOG_FILTER = 'labels.sink="analytics"'

/** Reads the view query `<name>.sql` from ../analytics/sql/. */
const readSql = (name: string): string =>
	readFileSync(
		new URL(`../analytics/sql/${name}.sql`, import.meta.url),
		'utf8',
	)

/**
 * AnalyticsWarehouseComponent puts PostHog events and the backend's analytics
 * log lines next to `billing_export`, so one BigQuery query can join them.
 *
 *  - `posthog_raw`: written hourly by a PostHog batch export, which
 *    impersonates `posthog-export` (no key). The export itself is set in
 *    PostHog's UI; see docs/runbooks/posthog-bigquery-export.md.
 *  - `analytics` log bucket + sink + `logs_analytics` linked dataset: the
 *    lines marked `labels.sink="analytics"`, kept 400 days. The link exposes
 *    each entry's payload as JSON, so a field whose type differs between
 *    lines is kept (a BigQuery sink fixes each column from the first entry).
 *  - `analytics_staging` / `analytics_marts`: the views Data Studio reads.
 *
 * No dataset has a default table expiry: history is the point, and the
 * volume is small. Prod only, like `billing_export`.
 */
export class AnalyticsWarehouseComponent extends pulumi.ComponentResource {
	public readonly posthogRaw: gcp.bigquery.Dataset
	public readonly staging: gcp.bigquery.Dataset
	public readonly marts: gcp.bigquery.Dataset
	public readonly logBucket: gcp.logging.ProjectBucketConfig
	public readonly posthogExportSaEmail: pulumi.Output<string>

	constructor(
		name: string,
		args: AnalyticsWarehouseComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:AnalyticsWarehouseComponent', name, args, opts)

		const { project, location = 'asia-northeast1' } = args

		const dataset = (datasetId: string, description: string) =>
			new gcp.bigquery.Dataset(
				datasetId.replace(/_/g, '-'),
				{
					datasetId,
					description,
					location,
					project: project.projectId,
				},
				{ parent: this },
			)

		this.posthogRaw = dataset(
			'posthog_raw',
			'PostHog events and persons, written hourly by the PostHog batch export. ' +
				'See docs/runbooks/posthog-bigquery-export.md.',
		)
		this.staging = dataset(
			'analytics_staging',
			'Views over posthog_raw, logs_analytics and billing_export: one row per meaning, JST dates, typed columns.',
		)
		this.marts = dataset(
			'analytics_marts',
			'Views read by the Data Studio reports. See docs/runbooks/analytics-dashboards.md.',
		)

		// The account PostHog impersonates. It may run load jobs in the
		// project and write posthog_raw only.
		const iam = new IamService(project)
		const posthogExport = iam.createServiceAccount(
			'posthog-export',
			'posthog-export',
			'PostHog BigQuery export',
			`Impersonated by PostHog to write posthog_raw. posthog:${POSTHOG_ORGANIZATION_ID}`,
			this,
		)
		this.posthogExportSaEmail = posthogExport.email
		iam.bindProjectRoles(
			[Roles.BigQuery.JobUser],
			'posthog-export',
			posthogExport.email,
			this,
		)
		new gcp.bigquery.DatasetIamMember(
			'posthog-export-x-posthog-raw-data-editor',
			{
				project: project.projectId,
				datasetId: this.posthogRaw.datasetId,
				role: Roles.BigQuery.DataEditor,
				member: pulumi.interpolate`serviceAccount:${posthogExport.email}`,
			},
			{ parent: this },
		)
		// Impersonation: a token for the account, and `iam.serviceAccounts.get`
		// on it. The project's org policy override allows a member from
		// another domain (`iam.allowedPolicyMemberDomains` is allowAll here).
		for (const [suffix, role] of [
			['token-creator', Roles.Iam.ServiceAccountTokenCreator],
			['viewer', Roles.Iam.ServiceAccountViewer],
		] as const) {
			new gcp.serviceaccount.IAMMember(
				`posthog-export-posthog-${suffix}`,
				{
					serviceAccountId: posthogExport.name,
					role,
					member: `serviceAccount:${POSTHOG_BATCH_EXPORTS_SA}`,
				},
				{ parent: this },
			)
		}

		// The analytics log bucket. A sink into a log bucket of the same
		// project needs no grant for its writer identity.
		this.logBucket = new gcp.logging.ProjectBucketConfig(
			'analytics-log-bucket',
			{
				project: project.projectId,
				location,
				bucketId: 'analytics',
				description:
					'Backend log lines marked labels.sink="analytics", kept for analysis beyond operations.',
				retentionDays: 400,
				enableAnalytics: true,
			},
			{ parent: this },
		)
		new gcp.logging.ProjectSink(
			'analytics-log-sink',
			{
				project: project.projectId,
				name: 'analytics',
				description:
					'Routes every analytics log line to the analytics bucket, whatever its topic.',
				destination: pulumi.interpolate`logging.googleapis.com/${this.logBucket.id}`,
				filter: ANALYTICS_LOG_FILTER,
			},
			{ parent: this },
		)
		const logLink = new gcp.logging.LinkedDataset(
			'analytics-log-link',
			{
				linkId: 'logs_analytics',
				bucket: this.logBucket.id,
				description:
					'Read-only BigQuery view of the analytics log bucket (_AllLogs).',
			},
			{ parent: this },
		)

		// The views Data Studio reads. Their SQL lives in ../analytics/sql/,
		// with {{project}} and {{billing_account}} filled in here. A view that
		// reads another view depends on it, so staging is created first.
		const billingAccount = project.billingAccount.apply((id) =>
			(id ?? '').replace(/-/g, '_'),
		)
		const view = (
			dataset: gcp.bigquery.Dataset,
			tableId: string,
			dependsOn: pulumi.Resource[],
		) =>
			new gcp.bigquery.Table(
				tableId.replace(/_/g, '-'),
				{
					project: project.projectId,
					datasetId: dataset.datasetId,
					tableId,
					// A view holds no data; a changed query may replace it.
					deletionProtection: false,
					view: {
						useLegacySql: false,
						query: pulumi
							.all([project.projectId, billingAccount])
							.apply(([projectId, account]) =>
								readSql(tableId)
									.replace(/{{project}}/g, projectId)
									.replace(/{{billing_account}}/g, account),
							),
					},
				},
				{ parent: this, dependsOn },
			)

		const stgEvents = view(this.staging, 'stg_events', [])
		const stgPersons = view(this.staging, 'stg_persons', [])
		const stgAiGenerations = view(this.staging, 'stg_ai_generations', [
			stgEvents,
		])
		const stgBillingDaily = view(this.staging, 'stg_billing_daily', [])
		const stgBillingResourceDaily = view(
			this.staging,
			'stg_billing_resource_daily',
			[],
		)
		const stgLogLines = view(this.staging, 'stg_log_lines', [logLink])

		const martGeminiCostDaily = view(this.marts, 'mart_gemini_cost_daily', [
			stgBillingDaily,
			stgAiGenerations,
		])
		view(this.marts, 'mart_cost_per_concert_monthly', [
			martGeminiCostDaily,
			stgEvents,
			stgLogLines,
		])
		view(this.marts, 'mart_unit_economics_monthly', [
			stgEvents,
			stgBillingDaily,
		])
		view(this.marts, 'mart_infra_cost_daily', [stgBillingResourceDaily])
		view(this.marts, 'mart_campaign_value', [stgEvents, stgPersons])
		view(this.marts, 'mart_pipeline_health_daily', [stgLogLines])

		this.registerOutputs({
			posthogExportSaEmail: this.posthogExportSaEmail,
		})
	}
}
