import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

import { getAccessToken, httpRequest, zitadelApiCall } from '../api-client.js'

// api-client.ts uses CommonJS-style `require('node:https')` because Pulumi
// Dynamic Resource serialization requires runtime resolution of Node
// built-ins. vi.mock('node:https') does not intercept those require calls
// from inside an ESM file, so we monkey-patch `https.request` at the module
// singleton level instead — every consumer of `node:https` shares the same
// instance, so the patch is visible to api-client.ts.
type RequestCall = {
	options: {
		method: string
		hostname: string
		port: number | string
		path: string
		headers: Record<string, string>
	}
	body: string
	respond: (statusCode: number, body: string) => void
}

const requestCalls: RequestCall[] = []
let originalRequest: typeof https.request

beforeAll(() => {
	originalRequest = https.request
	;(https as { request: unknown }).request = ((
		options: RequestCall['options'],
		callback: (res: EventEmitter & { statusCode: number }) => void,
	) => {
		const req = new EventEmitter() as EventEmitter & {
			write: (chunk: string) => void
			end: () => void
		}
		const chunks: string[] = []
		req.write = (chunk: string) => {
			chunks.push(chunk)
		}
		req.end = () => {
			requestCalls.push({
				options,
				body: chunks.join(''),
				respond: (statusCode: number, body: string) => {
					const res = new EventEmitter() as EventEmitter & {
						statusCode: number
					}
					res.statusCode = statusCode
					callback(res)
					res.emit('data', Buffer.from(body, 'utf-8'))
					res.emit('end')
				},
			})
		}
		return req
	}) as unknown as typeof https.request
})

afterAll(() => {
	;(https as { request: unknown }).request = originalRequest
})

beforeEach(() => {
	requestCalls.length = 0
})

afterEach(() => {
	requestCalls.length = 0
})

// Generate a fresh 2048-bit RSA keypair per test process so getAccessToken
// can exercise the real RS256 signing path against the patched transport
// without committing key material to the repo.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const testPrivateKey = privateKey
	.export({ format: 'pem', type: 'pkcs8' })
	.toString()

function lastCall(idx = 0): RequestCall {
	const call = requestCalls[idx]
	if (!call) throw new Error(`requestCalls[${idx}] is undefined`)
	return call
}

describe('httpRequest', () => {
	it('issues the HTTP request with the supplied method, headers and body', async () => {
		const promise = httpRequest({
			method: 'POST',
			url: 'https://example.test:8443/some/path?q=1',
			headers: { 'Content-Type': 'application/json' },
			body: '{"hello":"world"}',
		})
		// Yield once so api-client's synchronous req.write/req.end fires.
		await Promise.resolve()
		expect(requestCalls).toHaveLength(1)
		const call = lastCall()
		expect(call.options.method).toBe('POST')
		expect(call.options.hostname).toBe('example.test')
		expect(String(call.options.port)).toBe('8443')
		expect(call.options.path).toBe('/some/path?q=1')
		expect(call.options.headers).toEqual({
			'Content-Type': 'application/json',
		})
		expect(call.body).toBe('{"hello":"world"}')
		call.respond(200, '{"ok":true}')
		const res = await promise
		expect(res.statusCode).toBe(200)
		expect(res.body).toBe('{"ok":true}')
	})
})

describe('getAccessToken', () => {
	it('exchanges the JWT assertion at /oauth/v2/token via JWT-bearer grant and returns the access_token', async () => {
		const profile = {
			type: 'serviceaccount' as const,
			keyId: 'kid-1',
			key: testPrivateKey,
			userId: 'user-1',
		}
		const promise = getAccessToken('auth.example.test', profile)
		await Promise.resolve()
		expect(requestCalls).toHaveLength(1)
		const call = lastCall()
		expect(call.options.method).toBe('POST')
		expect(call.options.hostname).toBe('auth.example.test')
		expect(call.options.path).toBe('/oauth/v2/token')
		expect(call.options.headers['Content-Type']).toBe(
			'application/x-www-form-urlencoded',
		)
		const params = new URLSearchParams(call.body)
		expect(params.get('grant_type')).toBe(
			'urn:ietf:params:oauth:grant-type:jwt-bearer',
		)
		expect(params.get('scope')).toBe(
			'openid urn:zitadel:iam:org:project:id:zitadel:aud',
		)
		expect(params.get('assertion')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
		call.respond(200, '{"access_token":"abc.def.ghi"}')
		const token = await promise
		expect(token).toBe('abc.def.ghi')
	})

	it('throws when the upstream returns a non-2xx status', async () => {
		const profile = {
			type: 'serviceaccount' as const,
			keyId: 'kid-1',
			key: testPrivateKey,
			userId: 'user-1',
		}
		const promise = getAccessToken('auth.example.test', profile)
		await Promise.resolve()
		expect(requestCalls).toHaveLength(1)
		lastCall().respond(401, '{"error":"invalid_grant"}')
		await expect(promise).rejects.toThrow(/Zitadel token exchange failed/)
	})
})

describe('zitadelApiCall', () => {
	it('first calls the token endpoint, then issues the authenticated request with the bearer token', async () => {
		const profile = {
			type: 'serviceaccount' as const,
			keyId: 'kid-1',
			key: testPrivateKey,
			userId: 'user-1',
		}
		const promise = zitadelApiCall({
			domain: 'auth.example.test',
			profile,
			method: 'POST',
			path: '/v2/actions/targets',
			body: { name: 'x' },
		})
		await Promise.resolve()
		expect(requestCalls).toHaveLength(1)
		lastCall().respond(200, '{"access_token":"tok-123"}')
		// Wait for the token-exchange microtask chain to settle and the
		// second request (the actual API call) to be dispatched.
		await vi.waitFor(() => expect(requestCalls).toHaveLength(2))
		const apiCall = lastCall(1)
		expect(apiCall.options.method).toBe('POST')
		expect(apiCall.options.hostname).toBe('auth.example.test')
		expect(apiCall.options.path).toBe('/v2/actions/targets')
		expect(apiCall.options.headers.Authorization).toBe('Bearer tok-123')
		expect(apiCall.options.headers['Content-Type']).toBe('application/json')
		expect(apiCall.body).toBe('{"name":"x"}')
		apiCall.respond(201, '{"id":"tgt-1"}')
		const res = await promise
		expect(res.statusCode).toBe(201)
		expect(res.body).toBe('{"id":"tgt-1"}')
	})
})
