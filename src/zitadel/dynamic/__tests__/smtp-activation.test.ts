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

function callArgsAt(index: number) {
	return mockedCall.mock.calls[index][0]
}

/**
 * Default `_search` response used by happy-path tests: returns one SMTP
 * config with a discovered id distinct from `inputs.smtpConfigId`. This
 * mirrors the v4 reality where `inputs.smtpConfigId` is the IAM org id
 * (provider workaround in `smtp-activation.ts`) and the real activation
 * id is the snowflake returned by `_search`.
 */
const searchOneConfigResponse = {
	statusCode: 200,
	body: JSON.stringify({
		result: [{ id: 'real-cfg-snowflake', state: 'SMTP_CONFIG_INACTIVE' }],
	}),
}

describe('smtpActivationProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('discovers the real id via /admin/v1/smtp/_search, then POSTs /admin/v1/smtp/{realId}/_activate', async () => {
		mockedCall.mockResolvedValueOnce(searchOneConfigResponse) // search
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' }) // activate

		const result = await provider.create(baseInputs)

		expect(mockedCall).toHaveBeenCalledTimes(2)
		const search = callArgsAt(0)
		expect(search.method).toBe('POST')
		expect(search.path).toBe('/admin/v1/smtp/_search')
		const activate = callArgsAt(1)
		expect(activate.method).toBe('POST')
		expect(activate.path).toBe(
			'/admin/v1/smtp/real-cfg-snowflake/_activate',
		)
		expect(activate.domain).toBe('auth.example.test')
		// Activation has no payload; body is intentionally undefined.
		expect(activate.body).toBeUndefined()
		expect(result.id).toBe('smtp-activation:real-cfg-snowflake')
		expect(result.outs?.smtpConfigId).toBe('smtp-cfg-1')
		expect(result.outs?.activatedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		)
	})

	it('treats an "already active" upstream response on _activate as success (idempotency on first apply against manually-activated SMTP)', async () => {
		mockedCall.mockResolvedValueOnce(searchOneConfigResponse)
		mockedCall.mockResolvedValueOnce({
			statusCode: 412,
			body: '{"code":9,"message":"smtp config is already active"}',
		})

		await expect(provider.create(baseInputs)).resolves.toMatchObject({
			id: 'smtp-activation:real-cfg-snowflake',
		})
	})

	it('throws on a genuine non-2xx error from _activate (not the already-active case)', async () => {
		mockedCall.mockResolvedValueOnce(searchOneConfigResponse)
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"code":13,"message":"internal"}',
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel ActivateSmtpConfig failed \(500\)/,
		)
	})

	it('throws on a non-2xx from _search so the upstream lookup failure surfaces clearly', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"code":13,"message":"internal"}',
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel SearchSmtpConfigs failed \(500\)/,
		)
	})

	it('throws when _search returns zero configs (graph dependency should make this impossible — guards against silent skip)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({ result: [] }),
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel SearchSmtpConfigs returned 0 configs/,
		)
	})

	it('throws when _search returns more than one config (workaround assumes singleton)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({
				result: [{ id: 'cfg-a' }, { id: 'cfg-b' }],
			}),
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel SearchSmtpConfigs returned 2 configs/,
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
