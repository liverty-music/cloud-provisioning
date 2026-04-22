/**
 * Zitadel Management REST API helpers used by the Dynamic Resource providers
 * in this directory. All functions are pure and side-effect-free beyond their
 * HTTPS calls, so they survive Pulumi dynamic-provider serialization when
 * embedded into a ResourceProvider's CRUD callbacks.
 *
 * This module targets Node built-ins only (`crypto`, `https`, `url`) — adding
 * external imports here risks breaking the serialization contract used by
 * Pulumi to ship the provider closure to its worker process.
 */

export interface JwtProfile {
	type: 'serviceaccount'
	keyId: string
	key: string
	userId: string
}

/**
 * Build a short-lived (60s) RS256 JWT signed with the admin machine user's
 * private key, suitable for exchange at `/oauth/v2/token` for an access token.
 * Follows RFC 7523 (OAuth 2.0 Assertion Framework).
 */
export function buildAssertion(profile: JwtProfile, audience: string): string {
	const crypto = require('node:crypto') as typeof import('node:crypto')
	const now = Math.floor(Date.now() / 1000)
	const header = {
		alg: 'RS256',
		kid: profile.keyId,
		typ: 'JWT',
	}
	const payload = {
		iss: profile.userId,
		sub: profile.userId,
		aud: audience,
		exp: now + 60,
		iat: now,
	}
	const b64url = (buf: Buffer) =>
		buf
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')
	const encodedHeader = b64url(Buffer.from(JSON.stringify(header)))
	const encodedPayload = b64url(Buffer.from(JSON.stringify(payload)))
	const signingInput = `${encodedHeader}.${encodedPayload}`
	const signer = crypto.createSign('RSA-SHA256')
	signer.update(signingInput)
	signer.end()
	const signature = b64url(signer.sign(profile.key))
	return `${signingInput}.${signature}`
}

/**
 * Exchange the JWT assertion for a Zitadel access token via the JWT-bearer
 * grant. The access token is used as `Authorization: Bearer` on subsequent
 * Zitadel Management REST calls.
 */
export async function getAccessToken(
	domain: string,
	profile: JwtProfile,
): Promise<string> {
	const audience = `https://${domain}`
	const assertion = buildAssertion(profile, audience)
	const body = new URLSearchParams({
		grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		scope: 'openid urn:zitadel:iam:org:project:id:zitadel:aud',
		assertion,
	}).toString()
	const res = await httpRequest({
		method: 'POST',
		url: `${audience}/oauth/v2/token`,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	})
	if (res.statusCode < 200 || res.statusCode >= 300) {
		throw new Error(
			`Zitadel token exchange failed (${res.statusCode}): ${res.body}`,
		)
	}
	const parsed = JSON.parse(res.body) as { access_token?: string }
	if (!parsed.access_token) {
		throw new Error(
			`Zitadel token exchange returned no access_token: ${res.body}`,
		)
	}
	return parsed.access_token
}

export interface HttpRequestInput {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	url: string
	headers?: Record<string, string>
	body?: string
}

export interface HttpResponse {
	statusCode: number
	body: string
}

export async function httpRequest(
	input: HttpRequestInput,
): Promise<HttpResponse> {
	const https = require('node:https') as typeof import('node:https')
	const { URL } = require('node:url') as typeof import('node:url')
	const parsedUrl = new URL(input.url)
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				method: input.method,
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || 443,
				path: `${parsedUrl.pathname}${parsedUrl.search}`,
				headers: input.headers ?? {},
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk) => chunks.push(chunk as Buffer))
				res.on('end', () =>
					resolve({
						statusCode: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf-8'),
					}),
				)
				res.on('error', reject)
			},
		)
		req.on('error', reject)
		if (input.body) req.write(input.body)
		req.end()
	})
}

/**
 * Convenience helper that runs the token exchange + an authenticated REST call
 * in one step. Used by Dynamic Resource CRUD handlers below.
 */
export async function zitadelApiCall(opts: {
	domain: string
	profile: JwtProfile
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	path: string
	body?: unknown
}): Promise<{ statusCode: number; body: string }> {
	const token = await getAccessToken(opts.domain, opts.profile)
	return httpRequest({
		method: opts.method,
		url: `https://${opts.domain}${opts.path}`,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	})
}
