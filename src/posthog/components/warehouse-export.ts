import * as pulumi from '@pulumi/pulumi'
import {
	BigQueryExport,
	findGoogleCloudServiceAccountIntegration,
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
	/** PostHog personal API key with `integration:read` and
	 *  `batch_export:write` on project 190464. */
	apiKey: pulumi.Input<string>
	/** The account PostHog impersonates (`posthog-export`). */
	serviceAccountEmail: pulumi.Input<string>
	/** BigQuery dataset the exports write to (`posthog_raw`). */
	datasetId: pulumi.Input<string>
}

/**
 * The prod PostHog project's hourly exports of events and persons into
 * BigQuery, by impersonation of `posthog-export` (no key). They use the
 * project's `google-cloud-service-account` integration for that account,
 * which is made once in PostHog's UI (docs/runbooks/posthog-bigquery-export.md).
 * The Google Cloud side is `AnalyticsWarehouseComponent`; pass it in
 * `dependsOn` so the account and its grants exist first.
 */
export class WarehouseExport extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: WarehouseExportArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('liverty-music:posthog:WarehouseExport', name, {}, opts)

		// Made once in PostHog's UI: no API key can create an integration.
		const integrationId = pulumi
			.all([args.apiKey, args.serviceAccountEmail])
			.apply(([apiKey, email]) =>
				findGoogleCloudServiceAccountIntegration(apiKey, email),
			)

		for (const model of ['events', 'persons'] as const) {
			new BigQueryExport(
				`${name}-${model}`,
				{
					apiKey: args.apiKey,
					name: `BigQuery ${model}`,
					model,
					integrationId,
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
