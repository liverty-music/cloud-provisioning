import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api-client.js', () => ({
	zitadelApiCall: vi.fn(),
}))

const apiClient = await import('../api-client.js')
const { permanentPasswordProvider } = await import('../permanent-password.js')

const mockedCall = vi.mocked(apiClient.zitadelApiCall)

// `ZitadelHumanUserPasswordPermanent` is a one-shot state-push resource
// (per design D2 in OpenSpec change `zitadel-permanent-password`):
// `create()` and `update()` hit `POST /management/v1/users/{id}/password`;
// `delete()` and `read()` are no-ops. Test scaffold mirrors the
// smtp-activation precedent.
const provider = permanentPasswordProvider as Required<
	typeof permanentPasswordProvider
>

const baseProfile = {
	type: 'serviceaccount' as const,
	keyId: 'kid-1',
	key: 'private-key-pem',
	userId: 'user-1',
}

const baseInputs = {
	domain: 'auth.example.test',
	jwtProfileJson: JSON.stringify(baseProfile),
	userId: 'human-user-snowflake',
	password: 'sup3r-secret-passw0rd!',
}

const baseOutputs = {
	...baseInputs,
	markedAt: '2026-01-01T00:00:00.000Z',
}

function callArgsAt(index: number) {
	return mockedCall.mock.calls[index][0]
}

describe('permanentPasswordProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('POSTs /management/v1/users/{userId}/password with noChangeRequired=true', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		const result = await provider.create(baseInputs)

		expect(mockedCall).toHaveBeenCalledTimes(1)
		const call = callArgsAt(0)
		expect(call.method).toBe('POST')
		expect(call.path).toBe(
			'/management/v1/users/human-user-snowflake/password',
		)
		expect(call.domain).toBe('auth.example.test')
		expect(call.body).toEqual({
			password: baseInputs.password,
			noChangeRequired: true,
		})
		expect(result.id).toBe('permanent-password:human-user-snowflake')
		expect(result.outs?.userId).toBe('human-user-snowflake')
		expect(result.outs?.markedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		)
	})

	it('accepts a 412 "no change" response as success (idempotency on re-apply)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 412,
			body: '{"code":9,"message":"password no change required already set"}',
		})

		await expect(provider.create(baseInputs)).resolves.toMatchObject({
			id: 'permanent-password:human-user-snowflake',
		})
	})

	it('throws on a genuine non-2xx error from SetPassword', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"code":13,"message":"internal"}',
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel SetHumanPassword failed \(500\)/,
		)
	})
})

describe('permanentPasswordProvider.update', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('re-POSTs SetPassword with the new password and preserves the original markedAt', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })
		const news = { ...baseInputs, password: 'rotated-passw0rd!' }

		const result = await provider.update(
			'permanent-password:human-user-snowflake',
			baseOutputs,
			news,
		)

		expect(mockedCall).toHaveBeenCalledTimes(1)
		const call = callArgsAt(0)
		expect(call.method).toBe('POST')
		expect(call.path).toBe(
			'/management/v1/users/human-user-snowflake/password',
		)
		expect(call.body).toEqual({
			password: 'rotated-passw0rd!',
			noChangeRequired: true,
		})
		expect(result.outs?.markedAt).toBe(baseOutputs.markedAt)
		expect(result.outs?.password).toBe('rotated-passw0rd!')
	})

	it('throws on a genuine non-2xx error during update', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"code":13,"message":"internal"}',
		})

		await expect(
			provider.update(
				'permanent-password:human-user-snowflake',
				baseOutputs,
				baseInputs,
			),
		).rejects.toThrow(/Zitadel SetHumanPassword \(update\) failed \(500\)/)
	})
})

describe('permanentPasswordProvider.delete', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('makes ZERO HTTP requests (no inverse Management API verb exists)', async () => {
		await expect(
			provider.delete(
				'permanent-password:human-user-snowflake',
				baseOutputs,
			),
		).resolves.toBeUndefined()

		expect(mockedCall).not.toHaveBeenCalled()
	})
})

describe('permanentPasswordProvider.read', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('makes ZERO HTTP requests and returns current outputs unchanged', async () => {
		const result = await provider.read(
			'permanent-password:human-user-snowflake',
			baseOutputs,
		)

		expect(mockedCall).not.toHaveBeenCalled()
		expect(result.id).toBe('permanent-password:human-user-snowflake')
		expect(result.props).toEqual(baseOutputs)
	})
})
