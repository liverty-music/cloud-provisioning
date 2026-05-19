import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../api-client.js')>()
	return {
		...actual,
		systemApiCall: vi.fn(),
	}
})

const apiClient = await import('../api-client.js')
const { instanceCustomDomainProvider, mergeIcdSecretOutputs } = await import(
	'../instance-custom-domain.js'
)
const { buildSystemAssertion } = apiClient

const mockedCall = vi.mocked(apiClient.systemApiCall)

const provider = instanceCustomDomainProvider as Required<
	typeof instanceCustomDomainProvider
>

// A minimal RSA private key generated once at test load. Reusing across
// tests is fine — `buildSystemAssertion` is pure given the inputs.
const { generateKeyPairSync } = await import('node:crypto')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey
	.export({ format: 'pem', type: 'pkcs1' })
	.toString()

const baseInputs = {
	domain: 'auth.example.test',
	systemUserName: 'pulumi-system',
	privateKeyPem,
	instanceId: 'inst-1',
	customDomain: 'zitadel-api.zitadel.svc.cluster.local',
}

function lastCallArgs() {
	return mockedCall.mock.calls[mockedCall.mock.calls.length - 1][0]
}

function decodeJwtPart(part: string): Record<string, unknown> {
	const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
	return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))
}

describe('buildSystemAssertion', () => {
	it('emits an RS256 JWT with iss=sub=userName and aud=audience', () => {
		const before = Math.floor(Date.now() / 1000)
		const jwt = buildSystemAssertion(
			{ userName: 'pulumi-system', privateKeyPem },
			'https://auth.example.test',
		)
		const after = Math.floor(Date.now() / 1000)

		const [headerPart, payloadPart, signaturePart] = jwt.split('.')
		expect(signaturePart).toBeTruthy()

		const header = decodeJwtPart(headerPart)
		expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' })
		expect(header.kid).toBeUndefined()

		const payload = decodeJwtPart(payloadPart)
		expect(payload).toMatchObject({
			iss: 'pulumi-system',
			sub: 'pulumi-system',
			aud: 'https://auth.example.test',
		})
		expect(payload.iat).toBeGreaterThanOrEqual(before)
		expect(payload.iat).toBeLessThanOrEqual(after)
		expect(payload.exp).toBeGreaterThan(payload.iat as number)
		// 60 s lifetime keeps replay window small.
		expect((payload.exp as number) - (payload.iat as number)).toBe(60)
	})

	it('produces a signature verifiable by the matching public key', async () => {
		const crypto = await import('node:crypto')
		const { publicKey: unrelatedPublicKey } = crypto.generateKeyPairSync(
			'rsa',
			{ modulusLength: 2048 },
		)
		const matchingPublicKey = crypto.createPublicKey(privateKey)

		const jwt = buildSystemAssertion(
			{ userName: 'pulumi-system', privateKeyPem },
			'https://auth.example.test',
		)
		const [headerPart, payloadPart, signaturePart] = jwt.split('.')
		const signingInput = `${headerPart}.${payloadPart}`
		const signature = Buffer.from(
			signaturePart.replace(/-/g, '+').replace(/_/g, '/') +
				'='.repeat((4 - (signaturePart.length % 4)) % 4),
			'base64',
		)
		const verify = (key: crypto.KeyObject) => {
			const v = crypto.createVerify('RSA-SHA256')
			v.update(signingInput)
			v.end()
			return v.verify(key, signature)
		}
		expect(verify(matchingPublicKey)).toBe(true)
		// And does NOT verify with an unrelated public key.
		expect(verify(unrelatedPublicKey)).toBe(false)
	})
})

describe('mergeIcdSecretOutputs', () => {
	it('always includes privateKeyPem', () => {
		const merged = mergeIcdSecretOutputs()
		expect(merged.additionalSecretOutputs).toContain('privateKeyPem')
	})

	it('preserves caller-supplied additions', () => {
		const merged = mergeIcdSecretOutputs({
			additionalSecretOutputs: ['callerSecret'],
		})
		expect(merged.additionalSecretOutputs).toContain('privateKeyPem')
		expect(merged.additionalSecretOutputs).toContain('callerSecret')
	})

	it('preserves other CustomResourceOptions fields', () => {
		const merged = mergeIcdSecretOutputs({
			protect: true,
			additionalSecretOutputs: ['x'],
		})
		expect(merged.protect).toBe(true)
	})
})

describe('instanceCustomDomainProvider.create', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	it('POSTs AddCustomDomain and returns the composite id', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({
				details: { changeDate: '2026-05-19T00:00:00Z' },
			}),
		})
		const result = await provider.create(baseInputs)
		const call = lastCallArgs()
		expect(call.method).toBe('POST')
		expect(call.path).toBe(
			'/zitadel.instance.v2.InstanceService/AddCustomDomain',
		)
		expect(call.body).toEqual({
			instanceId: 'inst-1',
			customDomain: 'zitadel-api.zitadel.svc.cluster.local',
		})
		expect(call.profile.userName).toBe('pulumi-system')
		expect(result.id).toBe('inst-1/zitadel-api.zitadel.svc.cluster.local')
		expect(result.outs?.registeredId).toBe(result.id)
	})

	it('treats 409 AlreadyExists as success (idempotent)', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 409,
			body: JSON.stringify({
				code: 'already_exists',
				message: 'Domain already registered',
			}),
		})
		const result = await provider.create(baseInputs)
		expect(result.id).toBe('inst-1/zitadel-api.zitadel.svc.cluster.local')
	})

	it('surfaces 401/403 with actionable message', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 401,
			body: '{"code":"unauthenticated","message":"signature verification failed"}',
		})
		await expect(provider.create(baseInputs)).rejects.toThrow(
			/AddCustomDomain failed \(401\)/,
		)
	})

	it('surfaces 5xx with actionable message', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: 'internal',
		})
		await expect(provider.create(baseInputs)).rejects.toThrow(
			/AddCustomDomain failed \(500\)/,
		)
	})

	it('fails fast on the __UNSET__ instanceId sentinel', async () => {
		await expect(
			provider.create({ ...baseInputs, instanceId: '__UNSET__' }),
		).rejects.toThrow(/discover-zitadel-instance-id\.mjs/)
		expect(mockedCall).not.toHaveBeenCalled()
	})
})

describe('instanceCustomDomainProvider.read', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	const state = {
		...baseInputs,
		registeredId: 'inst-1/zitadel-api.zitadel.svc.cluster.local',
	}

	it('returns props when ListCustomDomains contains the domain', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({
				customDomains: [
					{ domain: 'auth.example.test' },
					{ domain: 'zitadel-api.zitadel.svc.cluster.local' },
				],
			}),
		})
		const result = await provider.read('id', state)
		expect(result.props).toBe(state)
	})

	it('accepts the alternative `result` + `customDomain` shape', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({
				result: [
					{ customDomain: 'zitadel-api.zitadel.svc.cluster.local' },
				],
			}),
		})
		const result = await provider.read('id', state)
		expect(result.props).toBe(state)
	})

	it('returns empty result when the domain has been deleted out-of-band', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 200,
			body: JSON.stringify({ customDomains: [{ domain: 'other' }] }),
		})
		const result = await provider.read('id', state)
		expect(result.props).toBeUndefined()
	})

	it('throws on non-2xx', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 500,
			body: 'oops',
		})
		await expect(provider.read('id', state)).rejects.toThrow(
			/ListCustomDomains failed \(500\)/,
		)
	})
})

describe('instanceCustomDomainProvider.diff', () => {
	const oldOuts = {
		...baseInputs,
		registeredId: 'inst-1/zitadel-api.zitadel.svc.cluster.local',
	}

	it('marks instanceId change as replace', async () => {
		const result = await provider.diff('id', oldOuts, {
			...baseInputs,
			instanceId: 'inst-2',
		})
		expect(result.replaces).toContain('instanceId')
		expect(result.changes).toBe(true)
	})

	it('marks customDomain change as replace', async () => {
		const result = await provider.diff('id', oldOuts, {
			...baseInputs,
			customDomain: 'other.svc.cluster.local',
		})
		expect(result.replaces).toContain('customDomain')
		expect(result.changes).toBe(true)
	})

	it('flags non-identity changes but does not replace (key rotation)', async () => {
		const result = await provider.diff('id', oldOuts, {
			...baseInputs,
			privateKeyPem: 'a-newer-pem',
		})
		expect(result.replaces ?? []).toEqual([])
		expect(result.changes).toBe(true)
	})

	it('reports no changes on identical inputs', async () => {
		const result = await provider.diff('id', oldOuts, { ...baseInputs })
		expect(result.changes).toBe(false)
	})
})

describe('instanceCustomDomainProvider.delete', () => {
	beforeEach(() => {
		mockedCall.mockReset()
	})

	const state = {
		...baseInputs,
		registeredId: 'inst-1/zitadel-api.zitadel.svc.cluster.local',
	}

	it('POSTs RemoveCustomDomain on delete', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 200, body: '{}' })
		await provider.delete('id', state)
		const call = lastCallArgs()
		expect(call.path).toBe(
			'/zitadel.instance.v2.InstanceService/RemoveCustomDomain',
		)
		expect(call.body).toEqual({
			instanceId: 'inst-1',
			customDomain: 'zitadel-api.zitadel.svc.cluster.local',
		})
	})

	it('tolerates 404 on delete', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 404, body: 'not found' })
		await expect(provider.delete('id', state)).resolves.toBeUndefined()
	})

	it('tolerates 400 NotFound on delete', async () => {
		mockedCall.mockResolvedValueOnce({
			statusCode: 400,
			body: '{"code":"NOT_FOUND","message":"already gone"}',
		})
		await expect(provider.delete('id', state)).resolves.toBeUndefined()
	})

	it('surfaces other errors', async () => {
		mockedCall.mockResolvedValueOnce({ statusCode: 500, body: 'boom' })
		await expect(provider.delete('id', state)).rejects.toThrow(
			/RemoveCustomDomain failed \(500\)/,
		)
	})
})
