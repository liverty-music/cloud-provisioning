import * as pulumi from '@pulumi/pulumi'

/**
 * PostHog's BigQuery batch export as a dynamic resource, which the PostHog
 * Terraform provider does not cover (1.0.26 has no batch export resource). It
 * calls the PostHog REST API with a personal API key that holds
 * `batch_export:write`.
 *
 * The export authenticates through a `google-cloud-service-account`
 * integration. No API key can create one: PostHog withholds
 * `integration:write` from personal API keys (`frontend/src/lib/scopes.tsx`,
 * `disabledActions`) and project secret API keys accept a short allowlist
 * without it. The integration is therefore made once in PostHog's UI, and
 * `findGoogleCloudServiceAccountIntegration` looks it up with
 * `integration:read`.
 *
 * Request shapes follow PostHog's serializers:
 * `products/batch_exports/backend/presentation/views/batch_export/destinations.py`.
 * Every key of `destination.config` that names a field of the workflow's
 * inputs reaches the export, `exclude_events` included, though PostHog's UI
 * offers that field only for S3 and Redshift (`service.py`,
 * `sync_batch_export`).
 *
 * The callbacks use the global `fetch` only: a module import here could
 * break the serialization Pulumi uses to ship the provider to its worker.
 */

/** PostHog EU Cloud, where the prod project lives. */
const POSTHOG_HOST = 'https://eu.posthog.com'

/** The prod PostHog project ("liverty-music-prod"). */
const POSTHOG_PROJECT_ID = '190464'

async function posthogApi(
	apiKey: string,
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
	path: string,
	body?: unknown,
): Promise<Record<string, unknown> | undefined> {
	const url = path.startsWith('https://')
		? path
		: `${POSTHOG_HOST}/api/environments/${POSTHOG_PROJECT_ID}/${path}`
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	if (method === 'DELETE' && res.status === 404) {
		// Already gone: deleting is done.
		return undefined
	}
	if (!res.ok) {
		throw new Error(
			`PostHog ${method} ${path} failed (${res.status}): ${text}`,
		)
	}
	return text ? (JSON.parse(text) as Record<string, unknown>) : undefined
}

interface IntegrationRow {
	id: number
	kind: string
	config?: { service_account_email?: string }
}

/**
 * Returns the id of the project's `google-cloud-service-account` integration
 * for `serviceAccountEmail`. Throws when there is none, naming the runbook
 * that creates it.
 */
export async function findGoogleCloudServiceAccountIntegration(
	apiKey: string,
	serviceAccountEmail: string,
): Promise<number> {
	let page: string | undefined = 'integrations/'
	while (page) {
		const res = await posthogApi(apiKey, 'GET', page)
		const rows = (res?.results ?? []) as IntegrationRow[]
		const match = rows.find(
			(r) =>
				r.kind === 'google-cloud-service-account' &&
				r.config?.service_account_email === serviceAccountEmail,
		)
		if (match) {
			return match.id
		}
		page = (res?.next as string | null) ?? undefined
	}
	throw new Error(
		`PostHog project ${POSTHOG_PROJECT_ID} has no google-cloud-service-account integration for ` +
			`${serviceAccountEmail}. Create it in PostHog's UI: docs/runbooks/posthog-bigquery-export.md.`,
	)
}

interface BigQueryExportInputs {
	apiKey: string
	name: string
	/** `events` or `persons`. */
	model: string
	integrationId: number
	datasetId: string
	tableId: string
	/** Exact event names; PostHog matches with `NOT IN`, not a pattern. */
	excludeEvents: string[]
}

function exportBody(inputs: BigQueryExportInputs) {
	return {
		name: inputs.name,
		model: inputs.model,
		interval: 'hour',
		destination: {
			type: 'BigQuery',
			integration_id: inputs.integrationId,
			config: {
				dataset_id: inputs.datasetId,
				table_id: inputs.tableId,
				// JSON columns for properties/set/set_once; fixed at creation.
				use_json_type: true,
				exclude_events: inputs.excludeEvents,
			},
		},
	}
}

/** Fields PostHog cannot change on an existing export, or that point it at
 *  another table. */
const EXPORT_REPLACE_KEYS = ['model', 'datasetId', 'tableId'] as const

export const bigQueryExportProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: BigQueryExportInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const created = await posthogApi(
			inputs.apiKey,
			'POST',
			'batch_exports/',
			exportBody(inputs),
		)
		return { id: String(created?.id), outs: inputs }
	},

	async diff(
		_id: string,
		olds: BigQueryExportInputs,
		news: BigQueryExportInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const changed = (
			Object.keys(news) as (keyof BigQueryExportInputs)[]
		).filter((k) => JSON.stringify(olds[k]) !== JSON.stringify(news[k]))
		return {
			changes: changed.length > 0,
			replaces: EXPORT_REPLACE_KEYS.filter((k) => changed.includes(k)),
			deleteBeforeReplace: true,
		}
	},

	async update(
		id: string,
		olds: BigQueryExportInputs,
		news: BigQueryExportInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const { apiKey: _old, ...oldFields } = olds
		const { apiKey: _new, ...newFields } = news
		if (JSON.stringify(oldFields) !== JSON.stringify(newFields)) {
			await posthogApi(
				news.apiKey,
				'PATCH',
				`batch_exports/${id}/`,
				exportBody(news),
			)
		}
		return { outs: news }
	},

	async delete(id: string, props: BigQueryExportInputs): Promise<void> {
		await posthogApi(props.apiKey, 'DELETE', `batch_exports/${id}/`)
	},
}

export interface BigQueryExportArgs {
	apiKey: pulumi.Input<string>
	name: pulumi.Input<string>
	model: pulumi.Input<'events' | 'persons'>
	integrationId: pulumi.Input<number>
	datasetId: pulumi.Input<string>
	tableId: pulumi.Input<string>
	excludeEvents: pulumi.Input<pulumi.Input<string>[]>
}

/** An hourly PostHog batch export into one BigQuery table. */
export class BigQueryExport extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: BigQueryExportArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(bigQueryExportProvider, name, args, {
			...opts,
			additionalSecretOutputs: ['apiKey'],
		})
	}
}
