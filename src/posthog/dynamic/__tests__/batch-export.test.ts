import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	bigQueryExportProvider,
	googleCloudServiceAccountIntegrationProvider,
} from '../batch-export.js'

const integrationProvider =
	googleCloudServiceAccountIntegrationProvider as Required<
		typeof googleCloudServiceAccountIntegrationProvider
	>
const exportProvider = bigQueryExportProvider as Required<
	typeof bigQueryExportProvider
>

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function respond(status: number, body: unknown) {
	fetchMock.mockResolvedValueOnce({
		ok: status >= 200 && status < 300,
		status,
		text: async () => (body === undefined ? '' : JSON.stringify(body)),
	})
}

function lastRequest() {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
	return {
		url,
		method: init.method,
		headers: init.headers as Record<string, string>,
		body: init.body ? JSON.parse(init.body as string) : undefined,
	}
}

const integrationInputs = {
	apiKey: 'phx_test',
	gcpProjectId: 'liverty-music-prod',
	serviceAccountEmail:
		'posthog-export@liverty-music-prod.iam.gserviceaccount.com',
}

const exportInputs = {
	apiKey: 'phx_test',
	name: 'BigQuery events',
	model: 'events',
	integrationId: 42,
	datasetId: 'posthog_raw',
	tableId: 'events',
	excludeEvents: ['perf.slow_interaction'],
}

beforeEach(() => {
	fetchMock.mockReset()
})

describe('googleCloudServiceAccountIntegrationProvider', () => {
	it('creates a google-cloud-service-account integration and returns its id', async () => {
		respond(201, { id: 42 })

		const result = await integrationProvider.create(integrationInputs)

		const req = lastRequest()
		expect(req.url).toBe(
			'https://eu.posthog.com/api/environments/190464/integrations/',
		)
		expect(req.method).toBe('POST')
		expect(req.headers.Authorization).toBe('Bearer phx_test')
		expect(req.body).toEqual({
			kind: 'google-cloud-service-account',
			config: {
				project_id: 'liverty-music-prod',
				service_account_email: integrationInputs.serviceAccountEmail,
			},
		})
		expect(result.id).toBe('42')
		expect(result.outs.integrationId).toBe(42)
	})

	it('replaces on a new service account but not on a new API key', async () => {
		const account = await integrationProvider.diff(
			'42',
			integrationInputs,
			{
				...integrationInputs,
				serviceAccountEmail:
					'other@liverty-music-prod.iam.gserviceaccount.com',
			},
		)
		const key = await integrationProvider.diff('42', integrationInputs, {
			...integrationInputs,
			apiKey: 'phx_rotated',
		})

		expect(account.replaces).toEqual(['serviceAccountEmail'])
		expect(key).toMatchObject({ changes: true, replaces: [] })
	})

	it('surfaces the PostHog error', async () => {
		respond(403, { detail: 'missing scope integration:write' })

		await expect(
			integrationProvider.create(integrationInputs),
		).rejects.toThrow(
			/POST integrations\/ failed \(403\).*integration:write/,
		)
	})
})

describe('bigQueryExportProvider', () => {
	it('creates an hourly BigQuery export through the integration, with the excluded events', async () => {
		respond(201, { id: 'be-1' })

		const result = await exportProvider.create(exportInputs)

		const req = lastRequest()
		expect(req.url).toBe(
			'https://eu.posthog.com/api/environments/190464/batch_exports/',
		)
		expect(req.body).toEqual({
			name: 'BigQuery events',
			model: 'events',
			interval: 'hour',
			destination: {
				type: 'BigQuery',
				integration_id: 42,
				config: {
					dataset_id: 'posthog_raw',
					table_id: 'events',
					use_json_type: true,
					exclude_events: ['perf.slow_interaction'],
				},
			},
		})
		expect(result.id).toBe('be-1')
	})

	it('replaces on a new table and updates on new excluded events', async () => {
		const table = await exportProvider.diff('be-1', exportInputs, {
			...exportInputs,
			tableId: 'events_v2',
		})
		const excluded = await exportProvider.diff('be-1', exportInputs, {
			...exportInputs,
			excludeEvents: [],
		})

		expect(table.replaces).toEqual(['tableId'])
		expect(excluded).toMatchObject({ changes: true, replaces: [] })
	})

	it('patches the export when a field changes', async () => {
		respond(200, { id: 'be-1' })

		await exportProvider.update('be-1', exportInputs, {
			...exportInputs,
			excludeEvents: [],
		})

		const req = lastRequest()
		expect(req.method).toBe('PATCH')
		expect(req.url).toBe(
			'https://eu.posthog.com/api/environments/190464/batch_exports/be-1/',
		)
		expect(req.body.destination.config.exclude_events).toEqual([])
	})

	it('sends nothing when only the API key changes', async () => {
		await exportProvider.update('be-1', exportInputs, {
			...exportInputs,
			apiKey: 'phx_rotated',
		})

		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('treats an export already deleted as deleted', async () => {
		respond(404, { detail: 'Not found.' })

		await expect(
			exportProvider.delete('be-1', exportInputs),
		).resolves.toBeUndefined()
	})
})
