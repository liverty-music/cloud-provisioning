import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api-client.js', () => ({
	zitadelApiCall: vi.fn(),
}))

const apiClient = await import('../api-client.js')
const { userIdpLinkProvider } = await import('../user-idp-link.js')

const mockedCall = vi.mocked(apiClient.zitadelApiCall)

const provider = userIdpLinkProvider as Required<typeof userIdpLinkProvider>

const baseProfile = {
	type: 'serviceaccount' as const,
	keyId: 'kid-1',
	key: 'private-key-pem',
	userId: 'machine-user-1',
}

const baseInputs = {
	domain: 'auth.example.test',
	jwtProfileJson: JSON.stringify(baseProfile),
	userId: 'local-user-1',
	idpId: 'idp-1',
	externalUserId: 'google-sub-1',
	displayName: 'Pannpers',
}

function lastCallArgs() {
	return mockedCall.mock.calls[0][0]
}

describe('userIdpLinkProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('POSTs /v2/users/{userId}/links with the idpLink body and returns a stable composite id', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 201, body: '{}' })

		const result = await provider.create(baseInputs)

		expect(mockedCall).toHaveBeenCalledOnce()
		const args = lastCallArgs()
		expect(args.method).toBe('POST')
		expect(args.path).toBe('/v2/users/local-user-1/links')
		expect(args.domain).toBe('auth.example.test')
		expect(args.body).toEqual({
			idpLink: {
				idpId: 'idp-1',
				userId: 'google-sub-1',
				userName: 'Pannpers',
			},
		})
		expect(result.id).toBe('user-idp-link:local-user-1:idp-1:google-sub-1')
		expect(result.outs).toEqual(baseInputs)
	})

	it('falls back to externalUserId when displayName is omitted (audit label is best-effort)', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 201, body: '{}' })

		const { displayName: _ignored, ...inputsNoDisplay } = baseInputs
		await provider.create(inputsNoDisplay)

		const args = lastCallArgs()
		expect(args.body).toMatchObject({
			idpLink: { userName: 'google-sub-1' },
		})
	})

	it('treats a 409 already-exists upstream as success (idempotent re-apply)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 409,
			body: '{"code":6,"message":"IDP link already exists (USER-AlreadyExists)"}',
		})

		await expect(provider.create(baseInputs)).resolves.toMatchObject({
			id: 'user-idp-link:local-user-1:idp-1:google-sub-1',
		})
	})

	it('throws on a genuine non-2xx error (not the already-exists case)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"code":13,"message":"internal"}',
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel AddIDPLink failed \(500\)/,
		)
	})

	it('throws on a non-409 4xx (e.g. 404 unknown user) so configuration mistakes surface loudly', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 404,
			body: '{"code":5,"message":"user not found"}',
		})

		await expect(provider.create(baseInputs)).rejects.toThrow(
			/Zitadel AddIDPLink failed \(404\)/,
		)
	})
})

describe('userIdpLinkProvider.update', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('makes ZERO HTTP requests and echoes news (immutable identity tuple, no soft-field push endpoint)', async () => {
		const news = { ...baseInputs, displayName: 'NewLabel' }
		const result = await provider.update(
			'user-idp-link:local-user-1:idp-1:google-sub-1',
			baseInputs,
			news,
		)

		expect(mockedCall).not.toHaveBeenCalled()
		expect(result.outs).toEqual(news)
	})
})

describe('userIdpLinkProvider.delete', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('DELETEs /v2/users/{userId}/links/{idpId}/{externalUserId}', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })

		await expect(
			provider.delete(
				'user-idp-link:local-user-1:idp-1:google-sub-1',
				baseInputs,
			),
		).resolves.toBeUndefined()

		const args = lastCallArgs()
		expect(args.method).toBe('DELETE')
		expect(args.path).toBe(
			'/v2/users/local-user-1/links/idp-1/google-sub-1',
		)
		expect(args.body).toBeUndefined()
	})

	it('treats 404 as success (link already gone — idempotent removal)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 404,
			body: '{"code":5,"message":"link not found"}',
		})

		await expect(
			provider.delete(
				'user-idp-link:local-user-1:idp-1:google-sub-1',
				baseInputs,
			),
		).resolves.toBeUndefined()
	})

	it('throws on non-2xx, non-404 (e.g. 500 server error) so real failures are not swallowed', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: '{"code":13,"message":"internal"}',
		})

		await expect(
			provider.delete(
				'user-idp-link:local-user-1:idp-1:google-sub-1',
				baseInputs,
			),
		).rejects.toThrow(/Zitadel RemoveIDPLink failed \(500\)/)
	})
})

describe('userIdpLinkProvider.read', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('makes ZERO HTTP requests and returns current outputs unchanged', async () => {
		const result = await provider.read(
			'user-idp-link:local-user-1:idp-1:google-sub-1',
			baseInputs,
		)

		expect(mockedCall).not.toHaveBeenCalled()
		expect(result.id).toBe('user-idp-link:local-user-1:idp-1:google-sub-1')
		expect(result.props).toEqual(baseInputs)
	})
})
