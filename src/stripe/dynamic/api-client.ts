/**
 * Minimal Stripe REST client for Pulumi Dynamic Resources.
 *
 * Mirrors `src/zitadel/dynamic/api-client.ts`: Dynamic Resource providers are
 * serialized and run outside the normal module graph, so they cannot rely on a
 * bundled SDK. Everything here uses `node:https` via `require` at call time for
 * the same reason.
 *
 * Stripe's REST API takes `application/x-www-form-urlencoded` bodies, including
 * for nested and repeated values, so `encodeForm` implements Stripe's bracket
 * convention rather than pulling in a dependency.
 */

export interface StripeResponse {
	statusCode: number
	body: string
}

/**
 * Encodes a value the way Stripe's API expects form data:
 * arrays as `key[0]`, `key[1]`, objects as `key[child]`.
 */
export function encodeForm(
	payload: Record<string, unknown>,
	prefix?: string,
): string {
	const parts: string[] = []
	for (const [rawKey, value] of Object.entries(payload)) {
		if (value === undefined || value === null) continue
		const key = prefix ? `${prefix}[${rawKey}]` : rawKey
		if (Array.isArray(value)) {
			value.forEach((item, index) => {
				parts.push(
					`${encodeURIComponent(`${key}[${index}]`)}=${encodeURIComponent(String(item))}`,
				)
			})
		} else if (typeof value === 'object') {
			const nested = encodeForm(value as Record<string, unknown>, key)
			if (nested) parts.push(nested)
		} else {
			parts.push(
				`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
			)
		}
	}
	return parts.join('&')
}

/**
 * Performs an authenticated Stripe REST call.
 *
 * `apiKey` should be a restricted key (`rk_live_…`) carrying only
 * `Webhook Endpoints: write` — Stripe recommends restricted keys over secret
 * keys wherever possible, and this caller needs nothing else. A key with wider
 * scope works too, but widens what a compromised Pulumi run can reach.
 */
export async function stripeApiCall(opts: {
	apiKey: string
	method: 'GET' | 'POST' | 'DELETE'
	path: string
	body?: Record<string, unknown>
	/** Stripe idempotency key; only meaningful on POST. */
	idempotencyKey?: string
}): Promise<StripeResponse> {
	const https = require('node:https') as typeof import('node:https')
	const encoded = opts.body ? encodeForm(opts.body) : undefined

	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.apiKey}`,
		Accept: 'application/json',
	}
	if (encoded !== undefined) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded'
		headers['Content-Length'] = String(Buffer.byteLength(encoded))
	}
	if (opts.idempotencyKey) {
		headers['Idempotency-Key'] = opts.idempotencyKey
	}

	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				method: opts.method,
				hostname: 'api.stripe.com',
				port: 443,
				path: opts.path,
				headers,
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
		if (encoded !== undefined) req.write(encoded)
		req.end()
	})
}

/** Extracts Stripe's error message from a non-2xx body, falling back to the raw body. */
export function stripeErrorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } }
		return parsed.error?.message ?? body
	} catch {
		return body
	}
}
