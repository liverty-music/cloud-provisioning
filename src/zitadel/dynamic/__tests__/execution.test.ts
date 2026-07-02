import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api-client.js', () => ({
	zitadelApiCall: vi.fn(),
}))

const apiClient = await import('../api-client.js')
const { executionFunctionProvider, executionRequestProvider } = await import(
	'../execution.js'
)

const mockedCall = vi.mocked(apiClient.zitadelApiCall)

// Cast away the `?:` optional modifiers on the lifecycle handlers so each
// test can call them as plain methods.
const fnProvider = executionFunctionProvider as Required<
	typeof executionFunctionProvider
>
const reqProvider = executionRequestProvider as Required<
	typeof executionRequestProvider
>

const baseProfile = {
	type: 'serviceaccount' as const,
	keyId: 'kid-1',
	key: 'private-key-pem',
	userId: 'user-1',
}

const baseFunctionInputs = {
	domain: 'auth.example.test',
	jwtProfileJson: JSON.stringify(baseProfile),
	functionName: 'preaccesstoken',
	targetIds: ['tgt-1', 'tgt-2'],
}

const baseRequestInputs = {
	domain: 'auth.example.test',
	jwtProfileJson: JSON.stringify(baseProfile),
	method: '/zitadel.user.v2.UserService/AddHumanUser',
	targetIds: ['tgt-1'],
}

function lastCallArgs() {
	return mockedCall.mock.calls[0][0]
}

describe('executionFunctionProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('PUTs /v2/actions/executions with `targets: string[]` (NOT `[]Target`) — encodes the §13.6 incident shape', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		const result = await fnProvider.create(baseFunctionInputs)

		expect(mockedCall).toHaveBeenCalledOnce()
		const args = lastCallArgs()
		// Zitadel v4 SetExecution is upsert-by-PUT, not POST/PATCH.
		expect(args.method).toBe('PUT')
		expect(args.path).toBe('/v2/actions/executions')
		expect(args.body).toEqual({
			condition: { function: { name: 'preaccesstoken' } },
			// MUST be a flat string array. The §13.6 incident sent
			// `[{target: id}]` which Zitadel v4 rejects.
			targets: ['tgt-1', 'tgt-2'],
		})
		const body = args.body as { targets: unknown[] }
		expect(typeof body.targets[0]).toBe('string')
		expect(result.id).toBe('function:preaccesstoken')
	})

	it('throws when Zitadel returns a non-2xx status', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 400,
			body: '{"error":"bad request"}',
		})

		await expect(fnProvider.create(baseFunctionInputs)).rejects.toThrow(
			/Zitadel SetExecution failed \(400\)/,
		)
	})
})

describe('executionFunctionProvider.update', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('uses PUT (matching the SetExecution upsert semantic) — NOT PATCH', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		await fnProvider.update('function:preaccesstoken', baseFunctionInputs, {
			...baseFunctionInputs,
			targetIds: ['tgt-3'],
		})

		const args = lastCallArgs()
		expect(args.method).toBe('PUT')
		expect(args.method).not.toBe('PATCH')
		expect(args.path).toBe('/v2/actions/executions')
		expect(args.body).toEqual({
			condition: { function: { name: 'preaccesstoken' } },
			targets: ['tgt-3'],
		})
	})
})

describe('executionFunctionProvider.delete', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('clears the binding by sending an empty targets array', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		await fnProvider.delete('function:preaccesstoken', baseFunctionInputs)

		const args = lastCallArgs()
		expect(args.method).toBe('PUT')
		expect(args.path).toBe('/v2/actions/executions')
		expect(args.body).toEqual({
			condition: { function: { name: 'preaccesstoken' } },
			targets: [],
		})
	})
})

describe('executionRequestProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('PUTs /v2/actions/executions with `targets: string[]` and a `request.method` condition', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		const result = await reqProvider.create(baseRequestInputs)

		const args = lastCallArgs()
		expect(args.method).toBe('PUT')
		expect(args.path).toBe('/v2/actions/executions')
		expect(args.body).toEqual({
			condition: {
				request: {
					method: '/zitadel.user.v2.UserService/AddHumanUser',
				},
			},
			targets: ['tgt-1'],
		})
		const body = args.body as { targets: unknown[] }
		expect(typeof body.targets[0]).toBe('string')
		expect(result.id).toBe(
			'request:/zitadel.user.v2.UserService/AddHumanUser',
		)
	})
})

describe('executionRequestProvider.update', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('uses PUT, NOT PATCH', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		await reqProvider.update(
			'request:/zitadel.user.v2.UserService/AddHumanUser',
			baseRequestInputs,
			{ ...baseRequestInputs, targetIds: ['tgt-9'] },
		)

		const args = lastCallArgs()
		expect(args.method).toBe('PUT')
		expect(args.method).not.toBe('PATCH')
	})
})

describe('executionRequestProvider.delete', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('clears the binding by sending an empty targets array', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		await reqProvider.delete(
			'request:/zitadel.user.v2.UserService/AddHumanUser',
			baseRequestInputs,
		)

		const args = lastCallArgs()
		expect(args.method).toBe('PUT')
		expect(args.body).toEqual({
			condition: {
				request: {
					method: '/zitadel.user.v2.UserService/AddHumanUser',
				},
			},
			targets: [],
		})
	})
})
