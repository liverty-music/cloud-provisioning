import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api-client.js', () => ({
	zitadelApiCall: vi.fn(),
}))

const apiClient = await import('../api-client.js')
const { targetProvider } = await import('../target.js')

const mockedCall = vi.mocked(apiClient.zitadelApiCall)

// Cast away the `?:` optional modifiers on the lifecycle handlers so each
// test can call them as plain methods. The provider in this module always
// implements the full lifecycle, so this is safe.
const provider = targetProvider as Required<typeof targetProvider>

const baseProfile = {
	type: 'serviceaccount' as const,
	keyId: 'kid-1',
	key: 'private-key-pem',
	userId: 'user-1',
}

const baseInputs = {
	domain: 'auth.example.test',
	jwtProfileJson: JSON.stringify(baseProfile),
	name: 'my-target',
	endpoint: 'http://backend.cluster:9090/pre-access-token',
	targetType: 'REST_CALL' as const,
	timeout: '10s',
	payloadType: 'PAYLOAD_TYPE_JWT' as const,
	interruptOnError: true,
}

const baseOutputs = { ...baseInputs, targetId: 'tgt-1' }

function lastCallArgs() {
	return mockedCall.mock.calls[0][0]
}

describe('targetProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('issues a POST to /v2/actions/targets with the documented Actions v2 body shape', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({ id: 'tgt-1', signingKey: 'sk-1' }),
		})

		const result = await provider.create(baseInputs)

		expect(mockedCall).toHaveBeenCalledOnce()
		const args = lastCallArgs()
		expect(args.method).toBe('POST')
		expect(args.path).toBe('/v2/actions/targets')
		expect(args.domain).toBe('auth.example.test')
		expect(args.body).toEqual({
			name: 'my-target',
			endpoint: 'http://backend.cluster:9090/pre-access-token',
			timeout: '10s',
			payloadType: 'PAYLOAD_TYPE_JWT',
			restCall: { interruptOnError: true },
		})
		expect(result.id).toBe('tgt-1')
		expect(result.outs?.targetId).toBe('tgt-1')
		expect(result.outs?.signingKey).toBe('sk-1')
	})

	it('routes REST_WEBHOOK targets to the restWebhook wrapper key', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({ id: 'tgt-2' }),
		})

		await provider.create({
			...baseInputs,
			targetType: 'REST_WEBHOOK',
		})

		const body = lastCallArgs().body as Record<string, unknown>
		expect(body.restWebhook).toEqual({ interruptOnError: true })
		expect(body.restCall).toBeUndefined()
		expect(body.restAsync).toBeUndefined()
	})

	it('throws when Zitadel returns a non-2xx status', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"error":"boom"}',
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel CreateTarget failed \(500\)/,
		)
	})
})

describe('targetProvider.update', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('issues a POST (NOT a PATCH) to /v2/actions/targets/{id} — encodes the §13.5 incident shape', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		await provider.update('tgt-1', baseOutputs, baseInputs)

		const args = lastCallArgs()
		// The method MUST be POST. PATCH on Actions v2 returns 405 Method Not
		// Allowed — re-asserting the §13.5 fix.
		expect(args.method).toBe('POST')
		expect(args.method).not.toBe('PATCH')
		expect(args.path).toBe('/v2/actions/targets/tgt-1')
	})
})

describe('targetProvider.delete', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('issues a DELETE to /v2/actions/targets/{id}', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 204, body: '' })

		await provider.delete('tgt-1', baseOutputs)

		const args = lastCallArgs()
		expect(args.method).toBe('DELETE')
		expect(args.path).toBe('/v2/actions/targets/tgt-1')
	})

	it('tolerates 404 (resource deleted out-of-band) without throwing', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 404,
			body: '{"error":"not found"}',
		})

		await expect(
			provider.delete('tgt-1', baseOutputs),
		).resolves.toBeUndefined()
	})

	it('throws on other non-2xx responses', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 500, body: '{}' })

		await expect(provider.delete('tgt-1', baseOutputs)).rejects.toThrow(
			/Zitadel DeleteTarget failed \(500\)/,
		)
	})
})

describe('targetProvider.read', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('issues a GET to /v2/actions/targets/{id}', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		await provider.read('tgt-1', baseOutputs)

		const args = lastCallArgs()
		expect(args.method).toBe('GET')
		expect(args.path).toBe('/v2/actions/targets/tgt-1')
	})

	it('returns the bare id (without props) when Zitadel responds 404', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 404,
			body: '{"error":"not found"}',
		})

		const res = await provider.read('tgt-1', baseOutputs)

		expect(res.id).toBe('tgt-1')
		expect(res.props).toBeUndefined()
	})

	it('throws when the upstream returns a non-2xx, non-404 response', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"error":"boom"}',
		})

		await expect(provider.read('tgt-1', baseOutputs)).rejects.toThrow(
			/Zitadel ReadTarget failed \(500\)/,
		)
	})
})
