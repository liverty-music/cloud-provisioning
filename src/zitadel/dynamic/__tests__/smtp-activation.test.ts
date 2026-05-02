import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api-client.js', () => ({
	zitadelApiCall: vi.fn(),
}))

const apiClient = await import('../api-client.js')
const { smtpActivationProvider } = await import('../smtp-activation.js')

const mockedCall = vi.mocked(apiClient.zitadelApiCall)

// `ZitadelSmtpActivation` is a side-effect-only Dynamic Resource (per
// `cutover-warning-fixes` design D2/D4): the only lifecycle handler that
// touches the Zitadel REST surface is `create()`. `update()` / `delete()` /
// `read()` are no-ops by design, so the test scaffold is intentionally
// narrower than the four-case scaffold used for `targetProvider` and
// `executionFunctionProvider`.
const provider = smtpActivationProvider as Required<
	typeof smtpActivationProvider
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
	smtpConfigId: 'smtp-cfg-1',
}

const baseOutputs = {
	...baseInputs,
	activatedAt: '2026-01-01T00:00:00.000Z',
}

function lastCallArgs() {
	return mockedCall.mock.calls[0][0]
}

describe('smtpActivationProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('POSTs /admin/v1/smtp/{id}/_activate and returns an activatedAt timestamp', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		const result = await provider.create(baseInputs)

		expect(mockedCall).toHaveBeenCalledOnce()
		const args = lastCallArgs()
		expect(args.method).toBe('POST')
		expect(args.path).toBe('/admin/v1/smtp/smtp-cfg-1/_activate')
		expect(args.domain).toBe('auth.example.test')
		// Activation has no payload; body is intentionally undefined.
		expect(args.body).toBeUndefined()
		expect(result.id).toBe('smtp-activation:smtp-cfg-1')
		expect(result.outs?.smtpConfigId).toBe('smtp-cfg-1')
		expect(result.outs?.activatedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		)
	})

	it('treats an "already active" upstream response as success (idempotency on first apply against manually-activated SMTP)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 412,
			body: '{"code":9,"message":"smtp config is already active"}',
		})

		await expect(provider.create(baseInputs)).resolves.toMatchObject({
			id: 'smtp-activation:smtp-cfg-1',
		})
	})

	it('throws on a genuine non-2xx error (not the already-active case)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"code":13,"message":"internal"}',
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel ActivateSmtpConfig failed \(500\)/,
		)
	})
})

describe('smtpActivationProvider.update', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('makes ZERO HTTP requests and preserves the original activatedAt', async () => {
		const result = await provider.update(
			'smtp-activation:smtp-cfg-1',
			baseOutputs,
			baseInputs,
		)

		expect(mockedCall).not.toHaveBeenCalled()
		expect(result.outs?.activatedAt).toBe(baseOutputs.activatedAt)
		expect(result.outs?.smtpConfigId).toBe('smtp-cfg-1')
	})
})

describe('smtpActivationProvider.delete', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('makes ZERO HTTP requests', async () => {
		await expect(
			provider.delete('smtp-activation:smtp-cfg-1', baseOutputs),
		).resolves.toBeUndefined()

		expect(mockedCall).not.toHaveBeenCalled()
	})
})

describe('smtpActivationProvider.read', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('makes ZERO HTTP requests and returns current outputs unchanged', async () => {
		const result = await provider.read(
			'smtp-activation:smtp-cfg-1',
			baseOutputs,
		)

		expect(mockedCall).not.toHaveBeenCalled()
		expect(result.id).toBe('smtp-activation:smtp-cfg-1')
		expect(result.props).toEqual(baseOutputs)
	})
})
