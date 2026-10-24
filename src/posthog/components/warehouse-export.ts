import * as pulumi from '@pulumi/pulumi'
import {
	BigQueryExport,
	GoogleCloudServiceAccountIntegration,
} from '../dynamic/batch-export.js'

/**
 * Performance telemetry stays in PostHog (OpenSpec `build-analytics-warehouse`,
 * Non-Goals). PostHog excludes by exact name, so a new `perf.*` event must be
 * added here.
 */
const PERFORMANCE_EVENTS = [
	'perf.long_animation_frame',
	'perf.slow_interaction',
	'perf.rpc_call_telemetry',
	'perf.discovery_reveal',
]

export interface WarehouseExportArgs {
	/** PostHog personal API key with `integration:write` and
	 *  `batch_export:write` on project 190464. */
	apiKey: pulumi.Input<string>
	/** Google Cloud project that holds the export's service account and dataset. */
	gcpProjectId: pulumi.Input<string>
	/** The account PostHog impersonates (`posthog-export`). */
	serviceAccountEmail: pulumi.Input<string>
	/** BigQuery dataset the exports write to (`posthog_raw`). */
	datasetId: pulumi.Input<string>
}

/**
 * The prod PostHog project's hourly exports of events and persons into
 * BigQuery, by impersonation of `posthog-export` (no key). The Google Cloud
 * side is `AnalyticsWarehouseComponent`; pass it in `dependsOn` so the
 * account and its grants exist before PostHog checks them.
 */
export class WarehouseExport extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: WarehouseExportArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('liverty-music:posthog:WarehouseExport', name, {}, opts)

		const integration = new GoogleCloudServiceAccountIntegration(
			`${name}-integration`,
			{
				apiKey: args.apiKey,
				gcpProjectId: args.gcpProjectId,
				serviceAccountEmail: args.serviceAccountEmail,
			},
			{ parent: this },
		)

		for (const model of ['events', 'persons'] as const) {
			new BigQueryExport(
				`${name}-${model}`,
				{
					apiKey: args.apiKey,
					name: `BigQuery ${model}`,
					model,
					integrationId: integration.integrationId,
					datasetId: args.datasetId,
					tableId: model,
					// The persons model has no event column; the filter is for events.
					excludeEvents: model === 'events' ? PERFORMANCE_EVENTS : [],
				},
				{ parent: this },
			)
		}

		this.registerOutputs({})
	}
}
