#!/usr/bin/env node
/**
 * One-shot helper that discovers a self-hosted Zitadel instance's id by
 * calling `instance.v2.InstanceService/ListInstances` with a JWT signed
 * by the Pulumi-managed `pulumi-system` System User.
 *
 * Used after Phase 1 of the `route-login-v2-via-internal-zitadel-api`
 * change has been applied (the `pulumi-system` user is declared via
 * `ZITADEL_SYSTEMAPIUSERS` on the `zitadel-api` Pod, and the
 * `zitadel-system-api-key` GSM Secret holds the private key). Output of
 * this script is the input for `instanceIdMap[env]` in
 * `src/zitadel/constants.ts` before Phase 2 wires up
 * `ZitadelInstanceCustomDomain`.
 *
 * Usage:
 *
 *     node scripts/discover-zitadel-instance-id.mjs --env=dev
 *     node scripts/discover-zitadel-instance-id.mjs --env=prod
 *
 * Requires:
 *   - `gcloud` on PATH, ADC pointing at the env's GCP project
 *     (i.e. `liverty-music-dev` or `liverty-music-prod` per memory
 *     `reference_gcloud_adc_per_directory.md`).
 *   - Read access on `secretmanager.versions.access` for
 *     `zitadel-system-api-key` (the Pulumi runner's SA has this; humans
 *     may need to `gcloud auth application-default login` first).
 *
 * Output: prints the instance id(s) to stdout, one per line. If a single
 * instance is returned (the self-hosted norm), the value is also printed
 * in the exact `instanceIdMap` literal form so you can paste it into
 * `constants.ts`.
 */

import { execSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { request } from 'node:https'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
	options: {
		env: { type: 'string', short: 'e' },
		user: { type: 'string', default: 'pulumi-system' },
		help: { type: 'boolean', short: 'h' },
	},
})

if (values.help || !values.env) {
	process.stderr.write(
		`Usage: node scripts/discover-zitadel-instance-id.mjs --env=<dev|prod> [--user=<name>]\n`,
	)
	process.exit(values.help ? 0 : 64)
}

const env = values.env
if (env !== 'dev' && env !== 'prod') {
	process.stderr.write(`error: --env must be 'dev' or 'prod', got '${env}'\n`)
	process.exit(64)
}

const project = `liverty-music-${env}`
const domain = env === 'dev' ? 'auth.dev.liverty-music.app' : 'auth.liverty-music.app'
const audience = `https://${domain}`
const userName = values.user

// Pull the private key from GSM. `gcloud` is the simplest path that
// doesn't introduce a new auth flow in this helper.
process.stderr.write(
	`[discover] reading private key from gsm: project=${project} secret=zitadel-system-api-key\n`,
)
const privateKeyPem = execSync(
	`gcloud secrets versions access latest --secret=zitadel-system-api-key --project=${project}`,
	{ encoding: 'utf-8' },
)

if (!privateKeyPem.includes('-----BEGIN')) {
	process.stderr.write(`error: unexpected gcloud output, no PEM header\n`)
	process.exit(1)
}

// Sign a 60s JWT.
// IMPORTANT: this block is a deliberate **duplicate** of
// `buildSystemAssertion` in `src/zitadel/dynamic/api-client.ts`. The
// canonical implementation lives in the Pulumi dynamic-provider source
// where it must use an inline `require('node:crypto')` for closure
// serialization; this .mjs script cannot pull that in without a build
// step, so we replay the logic. Any change to JWT header / payload /
// lifetime there MUST be mirrored here. See the corresponding JSDoc
// comment in api-client.ts (`buildSystemAssertion`) for the refactor
// note.
const now = Math.floor(Date.now() / 1000)
const b64url = (buf) =>
	buf
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
const payload = b64url(
	Buffer.from(
		JSON.stringify({
			iss: userName,
			sub: userName,
			aud: audience,
			iat: now,
			exp: now + 60,
		}),
	),
)
const signingInput = `${header}.${payload}`
const signer = createSign('RSA-SHA256')
signer.update(signingInput)
signer.end()
const signature = b64url(signer.sign(privateKeyPem))
const jwt = `${signingInput}.${signature}`

process.stderr.write(
	`[discover] POST ${audience}/zitadel.instance.v2.InstanceService/ListInstances\n`,
)

const responseBody = await new Promise((resolve, reject) => {
	const body = '{}'
	const req = request(
		`${audience}/zitadel.instance.v2.InstanceService/ListInstances`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${jwt}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'Content-Length': Buffer.byteLength(body),
			},
		},
		(res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf-8')
				if (res.statusCode < 200 || res.statusCode >= 300) {
					reject(
						new Error(
							`ListInstances failed (${res.statusCode}): ${text}`,
						),
					)
					return
				}
				resolve(text)
			})
			res.on('error', reject)
		},
	)
	req.on('error', reject)
	req.write(body)
	req.end()
})

const parsed = JSON.parse(responseBody)
const entries = parsed.instances ?? parsed.result ?? []
if (entries.length === 0) {
	process.stderr.write(
		`error: ListInstances returned an empty result\n` +
			`raw response: ${responseBody}\n`,
	)
	process.exit(1)
}

for (const entry of entries) {
	const id = entry.id ?? entry.instanceId
	if (id) process.stdout.write(`${id}\n`)
}

if (entries.length === 1) {
	const id = entries[0].id ?? entries[0].instanceId
	process.stderr.write(
		`\n[discover] paste this into src/zitadel/constants.ts (instanceIdMap):\n` +
			`  ${env}: '${id}',\n`,
	)
}
