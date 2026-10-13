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
const { paymentMethodPreferencesProvider } = await import(
	'../payment-method-preferences.js'
)

const mockedCall = vi.mocked(apiClient.stripeApiCall)

// Cast away the `?:` optional modifiers on the lifecycle handlers so each test
// can call them as plain methods. This provider implements the full lifecycle.
const provider = paymentMethodPreferencesProvider as Required<
	typeof paymentMethodPreferencesProvider
>

const inputs = {
	apiKey: 'sk_test_fake',
	preferences: { apple_pay: 'on', google_pay: 'on' } as const,
}

const method = (preference: string, available: boolean) => ({
	available,
	display_preference: { preference, value: preference },
})

const configuration = (google: string, googleAvailable: boolean) =>
	JSON.stringify({
		id: 'pmc_default',
		is_default: true,
		apple_pay: method('on', true),
		google_pay: method(google, googleAvailable),
	})

const outputs = {
	...inputs,
	configurationId: 'pmc_default',
	available: { apple_pay: true, google_pay: true },
}

beforeEach(() => {
	mockedCall.mockReset()
})

describe('paymentMethodPreferencesProvider.create', () => {
	it('turns the listed wallets on in the default configuration', async () => {
		mockedCall
			.mockResolvedValueOnce({
				statusCode: 200,
				body: JSON.stringify({
					data: [
						{ id: 'pmc_other', is_default: false },
						{ id: 'pmc_default', is_default: true },
					],
				}),
			})
			.mockResolvedValueOnce({
				statusCode: 200,
				body: configuration('on', true),
			})

		const result = await provider.create(inputs)

		expect(result.id).toBe('pmc_default')
		expect(result.outs.available).toEqual({
			apple_pay: true,
			google_pay: true,
		})
		expect(mockedCall.mock.calls[1]?.[0]).toMatchObject({
			method: 'POST',
			path: '/v1/payment_method_configurations/pmc_default',
			body: {
				apple_pay: { display_preference: { preference: 'on' } },
				google_pay: { display_preference: { preference: 'on' } },
			},
		})
	})

	it('fails when the account has no default configuration', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({
				data: [{ id: 'pmc_other', is_default: false }],
			}),
		})

		await expect(provider.create(inputs)).rejects.toThrow(
			'no default configuration',
		)
	})
})

describe('paymentMethodPreferencesProvider.read', () => {
	it('reports a wallet turned off in the Dashboard, so the next up turns it back on', async () => {
		mockedCall.mockResolvedValue({
			statusCode: 200,
			body: configuration('off', false),
		})

		const result = await provider.read('pmc_default', outputs)

		expect(result.props?.preferences).toEqual({
			apple_pay: 'on',
			google_pay: 'off',
		})
		expect(result.props?.available).toEqual({
			apple_pay: true,
			google_pay: false,
		})
	})
})

describe('paymentMethodPreferencesProvider.diff', () => {
	it('updates in place when a preference differs', async () => {
		const result = await provider.diff(
			'pmc_default',
			{ ...outputs, preferences: { apple_pay: 'on', google_pay: 'off' } },
			inputs,
		)

		expect(result).toMatchObject({ changes: true, replaces: [] })
	})

	it('updates in place when only the API key rotates, so later reads use the new key', async () => {
		const result = await provider.diff('pmc_default', outputs, {
			...inputs,
			apiKey: 'sk_test_rotated',
		})

		expect(result).toMatchObject({ changes: true, replaces: [] })
	})
})

describe('paymentMethodPreferencesProvider.delete', () => {
	it('leaves the account configuration untouched', async () => {
		await provider.delete('pmc_default', outputs)

		expect(mockedCall).not.toHaveBeenCalled()
	})
})
