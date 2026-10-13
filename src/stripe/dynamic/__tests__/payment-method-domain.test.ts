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
const { paymentMethodDomainProvider } = await import(
	'../payment-method-domain.js'
)

const mockedCall = vi.mocked(apiClient.stripeApiCall)

// Cast away the `?:` optional modifiers on the lifecycle handlers so each test
// can call them as plain methods. This provider implements the full lifecycle.
const provider = paymentMethodDomainProvider as Required<
	typeof paymentMethodDomainProvider
>

const inputs = { apiKey: 'sk_test_fake', domainName: 'liverty-music.app' }

const domain = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		id: 'pmd_1',
		domain_name: 'liverty-music.app',
		enabled: true,
		apple_pay: { status: 'active' },
		google_pay: { status: 'active' },
		...overrides,
	})

const outputs = {
	...inputs,
	domainId: 'pmd_1',
	applePayStatus: 'active',
	googlePayStatus: 'active',
}

beforeEach(() => {
	mockedCall.mockReset()
})

describe('paymentMethodDomainProvider.create', () => {
	it('registers a new domain enabled and reports both wallet statuses', async () => {
		mockedCall
			.mockResolvedValueOnce({ statusCode: 200, body: '{"data":[]}' })
			.mockResolvedValueOnce({ statusCode: 200, body: domain() })

		const result = await provider.create(inputs)

		expect(result.id).toBe('pmd_1')
		expect(result.outs).toEqual(outputs)
		expect(mockedCall.mock.calls[1]?.[0]).toMatchObject({
			method: 'POST',
			path: '/v1/payment_method_domains',
			body: { domain_name: 'liverty-music.app', enabled: true },
		})
	})

	it('adopts and re-enables an existing registration, since Stripe has no delete', async () => {
		mockedCall
			.mockResolvedValueOnce({
				statusCode: 200,
				body: `{"data":[${domain({ enabled: false })}]}`,
			})
			.mockResolvedValueOnce({ statusCode: 200, body: domain() })

		const result = await provider.create(inputs)

		expect(result.id).toBe('pmd_1')
		expect(mockedCall.mock.calls[1]?.[0]).toMatchObject({
			method: 'POST',
			path: '/v1/payment_method_domains/pmd_1',
			body: { enabled: true },
		})
	})

	it('fails with Stripe’s message when the registration is refused', async () => {
		mockedCall
			.mockResolvedValueOnce({ statusCode: 200, body: '{"data":[]}' })
			.mockResolvedValueOnce({
				statusCode: 400,
				body: JSON.stringify({ error: { message: 'Invalid domain' } }),
			})

		await expect(provider.create(inputs)).rejects.toThrow('Invalid domain')
	})
})

describe('paymentMethodDomainProvider.read', () => {
	it('refreshes the wallet statuses', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: domain({ apple_pay: { status: 'inactive' } }),
		})

		const result = await provider.read('pmd_1', outputs)

		expect(result.props?.applePayStatus).toBe('inactive')
	})

	it('reports a registration disabled outside Pulumi as absent, so the next up enables it', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: domain({ enabled: false }),
		})

		const result = await provider.read('pmd_1', outputs)

		expect(result.id).toBeUndefined()
	})

	it('reports a missing registration as absent', async () => {
		mockedCall.mockResolvedValue({ statusCode: 404, body: '{}' })

		const result = await provider.read('pmd_1', outputs)

		expect(result.id).toBeUndefined()
	})
})

describe('paymentMethodDomainProvider.diff', () => {
	it('replaces the registration when the domain changes', async () => {
		const result = await provider.diff('pmd_1', outputs, {
			...inputs,
			domainName: 'dev.liverty-music.app',
		})

		expect(result).toMatchObject({
			changes: true,
			replaces: ['domainName'],
		})
	})

	it('stores a rotated API key without replacing the registration', async () => {
		const diff = await provider.diff('pmd_1', outputs, {
			...inputs,
			apiKey: 'sk_test_rotated',
		})
		const updated = await provider.update('pmd_1', outputs, {
			...inputs,
			apiKey: 'sk_test_rotated',
		})

		expect(diff).toMatchObject({ changes: true, replaces: [] })
		expect(updated.outs?.apiKey).toBe('sk_test_rotated')
		expect(mockedCall).not.toHaveBeenCalled()
	})
})

describe('paymentMethodDomainProvider.delete', () => {
	it('disables the registration, since Stripe has no delete', async () => {
		mockedCall.mockResolvedValue({ statusCode: 200, body: domain() })

		await provider.delete('pmd_1', outputs)

		expect(mockedCall.mock.calls[0]?.[0]).toMatchObject({
			method: 'POST',
			path: '/v1/payment_method_domains/pmd_1',
			body: { enabled: false },
		})
	})

	it('treats an already missing registration as deleted', async () => {
		mockedCall.mockResolvedValue({ statusCode: 404, body: '{}' })

		await expect(provider.delete('pmd_1', outputs)).resolves.toBeUndefined()
	})
})
