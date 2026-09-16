import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api-client.js', async () => {
	const actual =
		await vi.importActual<typeof import('../api-client.js')>(
			'../api-client.js',
		)
	return {
		...actual,
		stripeApiCall: vi.fn(),
	}
})

const apiClient = await import('../api-client.js')
const { webhookEndpointProvider } = await import('../webhook-endpoint.js')

const mockedCall = vi.mocked(apiClient.stripeApiCall)

// Cast away the `?:` optional modifiers on the lifecycle handlers so each test
// can call them as plain methods. This provider implements the full lifecycle.
const provider = webhookEndpointProvider as Required<
	typeof webhookEndpointProvider
>

const baseInputs = {
	apiKey: 'rk_live_fake',
	url: 'https://api.liverty-music.app/stripe-webhook',
	enabledEvents: ['transfer.created', 'charge.refunded'],
	description: 'settlement webhooks',
}

const baseOutputs = {
	...baseInputs,
	enabledEvents: ['charge.refunded', 'transfer.created'],
	endpointId: 'we_1',
	signingSecret: 'whsec_original',
}

beforeEach(() => {
	mockedCall.mockReset()
})

describe('webhookEndpointProvider.create', () => {
	it('captures the signing secret, which Stripe returns only at creation', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: JSON.stringify({ id: 'we_1', secret: 'whsec_abc' }),
		})

		const result = await provider.create(baseInputs)

		expect(result.id).toBe('we_1')
		expect(result.outs.signingSecret).toBe('whsec_abc')
	})

	it('sorts the event list so a reordered list is not a spurious diff', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: JSON.stringify({ id: 'we_1', secret: 'whsec_abc' }),
		})

		const result = await provider.create(baseInputs)

		expect(result.outs.enabledEvents).toEqual([
			'charge.refunded',
			'transfer.created',
		])
		expect(mockedCall.mock.calls[0]?.[0]?.body?.enabled_events).toEqual([
			'charge.refunded',
			'transfer.created',
		])
	})

	it('fails loudly when Stripe returns no secret, rather than leaving an unverifiable endpoint', async () => {
		// Stripe never reissues the secret, so an endpoint created without one
		// receives events the backend can never verify.
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: JSON.stringify({ id: 'we_1' }),
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/no signing secret/,
		)
	})

	it('surfaces Stripe error messages on failure', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 400,
			body: JSON.stringify({ error: { message: 'Invalid URL' } }),
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(/Invalid URL/)
	})
})

describe('webhookEndpointProvider.read', () => {
	it('reports absence when the endpoint was deleted outside Pulumi', async () => {
		mockedCall.mockResolvedValue({ statusCode: 404, body: '{}' })

		const result = await provider.read('we_1', baseOutputs)

		expect(result.id).toBeUndefined()
		expect(result.props).toBeUndefined()
	})

	it('keeps the stored secret, since retrieve never returns it', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: JSON.stringify({
				url: baseInputs.url,
				enabled_events: ['charge.refunded', 'transfer.created'],
				description: 'settlement webhooks',
			}),
		})

		const result = await provider.read('we_1', baseOutputs)

		expect(result.props?.signingSecret).toBe('whsec_original')
	})

	it('picks up drift in the subscribed events', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: JSON.stringify({
				url: baseInputs.url,
				enabled_events: ['charge.refunded'],
				description: 'settlement webhooks',
			}),
		})

		const result = await provider.read('we_1', baseOutputs)

		expect(result.props?.enabledEvents).toEqual(['charge.refunded'])
	})
})

describe('webhookEndpointProvider.diff', () => {
	it('does not replace on an API-key rotation', async () => {
		// Replacing would mint a new signing secret and break delivery until the
		// backend picked it up; the key only changes how we authenticate.
		const result = await provider.diff('we_1', baseOutputs, {
			...baseInputs,
			apiKey: 'rk_live_rotated',
		})

		expect(result.changes).toBe(false)
		expect(result.replaces ?? []).toEqual([])
	})

	it('ignores event reordering', async () => {
		const result = await provider.diff('we_1', baseOutputs, {
			...baseInputs,
			enabledEvents: ['transfer.created', 'charge.refunded'],
		})

		expect(result.changes).toBe(false)
	})

	it('detects a real change to the subscribed events', async () => {
		const result = await provider.diff('we_1', baseOutputs, {
			...baseInputs,
			enabledEvents: ['charge.refunded'],
		})

		expect(result.changes).toBe(true)
	})

	it('updates in place rather than replacing when the URL changes', async () => {
		const result = await provider.diff('we_1', baseOutputs, {
			...baseInputs,
			url: 'https://api.liverty-music.app/webhook/stripe',
		})

		expect(result.changes).toBe(true)
		expect(result.replaces ?? []).toEqual([])
	})
})

describe('webhookEndpointProvider.update', () => {
	it('preserves the signing secret, which update does not reissue', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: JSON.stringify({ id: 'we_1' }),
		})

		const result = await provider.update('we_1', baseOutputs, {
			...baseInputs,
			description: 'renamed',
		})

		expect(result.outs.signingSecret).toBe('whsec_original')
		expect(result.outs.description).toBe('renamed')
	})
})

describe('webhookEndpointProvider.delete', () => {
	it('deletes the endpoint at Stripe', async () => {
		mockedCall.mockResolvedValue({ statusCode: 200, body: '{}' })

		await provider.delete('we_1', baseOutputs)

		expect(mockedCall).toHaveBeenCalledWith(
			expect.objectContaining({
				method: 'DELETE',
				path: '/v1/webhook_endpoints/we_1',
			}),
		)
	})

	it('treats an already-deleted endpoint as success so a retried destroy succeeds', async () => {
		mockedCall.mockResolvedValue({ statusCode: 404, body: '{}' })

		await expect(
			provider.delete('we_1', baseOutputs),
		).resolves.toBeUndefined()
	})

	it('raises other failures', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 500,
			body: JSON.stringify({ error: { message: 'boom' } }),
		})

		await expect(provider.delete('we_1', baseOutputs)).rejects.toThrow(
			/boom/,
		)
	})
})

describe('encodeForm', () => {
	it('encodes arrays with Stripe bracket indices', () => {
		expect(apiClient.encodeForm({ enabled_events: ['a.b', 'c.d'] })).toBe(
			'enabled_events%5B0%5D=a.b&enabled_events%5B1%5D=c.d',
		)
	})

	it('skips undefined values rather than sending empty strings', () => {
		expect(apiClient.encodeForm({ a: 'x', b: undefined })).toBe('a=x')
	})
})
