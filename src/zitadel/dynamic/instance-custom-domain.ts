import * as pulumi from '@pulumi/pulumi'
import { type SystemUserProfile, systemApiCall } from './api-client.js'

/**
 * Inputs accepted at construction. `pulumi.Input` wrappers are unwrapped
 * by Pulumi before the CRUD callbacks see them.
 */
export interface ZitadelInstanceCustomDomainArgs {
	/** Zitadel issuer hostname (e.g. `auth.dev.liverty-music.app`). Used as
	 *  the System User JWT audience and the HTTPS target host. */
	domain: pulumi.Input<string>
	/** Name of the System User declared in `ZITADEL_SYSTEMAPIUSERS` env.
	 *  Used as the JWT `iss`/`sub` claim. Must match the env value. */
	systemUserName: pulumi.Input<string>
	/** PEM-encoded RSA private key whose public half is in
	 *  `ZITADEL_SYSTEMAPIUSERS`. Pass as `pulumi.secret`-wrapped Output. */
	privateKeyPem: pulumi.Input<string>
	/** Target instance ID (from `instanceIdMap[env]` in
	 *  `src/zitadel/constants.ts`). */
	instanceId: pulumi.Input<string>
	/** Hostname to register, e.g. `zitadel-api.zitadel.svc.cluster.local`. */
	customDomain: pulumi.Input<string>
}

interface InstanceCustomDomainInputs {
	domain: string
	systemUserName: string
	privateKeyPem: string
	instanceId: string
	customDomain: string
}

interface InstanceCustomDomainOutputs extends InstanceCustomDomainInputs {
	/** Composite identity persisted in Pulumi state: `${instanceId}/${customDomain}`. */
	registeredId: string
}

/**
 * Decide whether a non-2xx response from `AddCustomDomain` should be
 * treated as success. Zitadel surfaces "already registered" via either:
 *
 *  - HTTP 409 with body containing an "AlreadyExists" / "ALREADY_EXISTS"
 *    Connect-RPC error code, or
 *  - HTTP 200 with `details.changeDate` reflecting an earlier creation.
 *
 * Both are acceptable. Other 4xx/5xx are real failures.
 */
function isAlreadyExists(statusCode: number, body: string): boolean {
	if (statusCode !== 409) return false
	const haystack = body.toLowerCase()
	return (
		haystack.includes('already_exists') ||
		haystack.includes('alreadyexists') ||
		haystack.includes('already registered')
	)
}

export const instanceCustomDomainProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: InstanceCustomDomainInputs,
	): Promise<pulumi.dynamic.CreateResult<InstanceCustomDomainOutputs>> {
		// Fail-fast on the `__UNSET__` sentinel from
		// `constants.ts:instanceIdMap`. Without this guard, Zitadel would
		// return a confusing `invalid_argument: instance_id` error and the
		// operator would have to dig through the Pulumi log to realise the
		// real problem is a missing post-bootstrap discovery step.
		if (inputs.instanceId === '__UNSET__') {
			throw new Error(
				'ZitadelInstanceCustomDomain: instanceId is the __UNSET__ sentinel. ' +
					'Run `node scripts/discover-zitadel-instance-id.mjs --env=<env>` after the ' +
					'Phase 1 deploy has rolled the zitadel-api Pod, then commit the captured id ' +
					'into instanceIdMap in src/zitadel/constants.ts.',
			)
		}
		const profile: SystemUserProfile = {
			userName: inputs.systemUserName,
			privateKeyPem: inputs.privateKeyPem,
		}
		const res = await systemApiCall({
			domain: inputs.domain,
			profile,
			method: 'POST',
			path: '/zitadel.instance.v2.InstanceService/AddCustomDomain',
			body: {
				instanceId: inputs.instanceId,
				customDomain: inputs.customDomain,
			},
		})
		const ok = res.statusCode >= 200 && res.statusCode < 300
		if (!ok && !isAlreadyExists(res.statusCode, res.body)) {
			throw new Error(
				`Zitadel AddCustomDomain failed (${res.statusCode}): ${res.body}`,
			)
		}
		const registeredId = `${inputs.instanceId}/${inputs.customDomain}`
		return {
			id: registeredId,
			outs: {
				...inputs,
				registeredId,
			},
		}
	},

	/**
	 * Drift detection. Reads `ListCustomDomains` and confirms the recorded
	 * customDomain is present. If the registration has been removed
	 * out-of-band (Console deletion, API call from elsewhere), returns an
	 * empty result so Pulumi schedules a re-create on next up.
	 */
	async read(
		id: string,
		state: InstanceCustomDomainOutputs,
	): Promise<pulumi.dynamic.ReadResult<InstanceCustomDomainOutputs>> {
		const profile: SystemUserProfile = {
			userName: state.systemUserName,
			privateKeyPem: state.privateKeyPem,
		}
		const res = await systemApiCall({
			domain: state.domain,
			profile,
			method: 'POST',
			path: '/zitadel.instance.v2.InstanceService/ListCustomDomains',
			body: {
				instanceId: state.instanceId,
				// Pagination guard: at platform scale the per-instance domain
				// count is tiny (handful), but request a generous page anyway
				// so we don't have to follow a `nextPageToken`.
				pagination: { limit: 100 },
			},
		})
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Zitadel ListCustomDomains failed (${res.statusCode}): ${res.body}`,
			)
		}
		const parsed = JSON.parse(res.body) as {
			customDomains?: Array<{ domain?: string; customDomain?: string }>
			result?: Array<{ domain?: string; customDomain?: string }>
		}
		// Zitadel's response shape has shifted between v2beta and v2; accept
		// either `customDomains` or `result` and either `domain` or
		// `customDomain` field within each entry. Defensive but harmless.
		const entries = parsed.customDomains ?? parsed.result ?? []
		const found = entries.some(
			(e) =>
				(e.domain ?? e.customDomain ?? '').toLowerCase() ===
				state.customDomain.toLowerCase(),
		)
		if (!found) {
			return { id }
		}
		return { id, props: state }
	},

	/**
	 * The `customDomain` and `instanceId` are the resource identity; if
	 * they change, the resource MUST be replaced (delete old + create new).
	 * Other input changes (`domain`, `privateKeyPem`, `systemUserName`)
	 * affect only how subsequent calls authenticate — no API call is
	 * needed, just persist new outs.
	 */
	async diff(
		_id: string,
		olds: InstanceCustomDomainOutputs,
		news: InstanceCustomDomainInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = []
		if (olds.instanceId !== news.instanceId) replaces.push('instanceId')
		if (olds.customDomain !== news.customDomain)
			replaces.push('customDomain')
		return {
			changes:
				replaces.length > 0 ||
				olds.domain !== news.domain ||
				olds.privateKeyPem !== news.privateKeyPem ||
				olds.systemUserName !== news.systemUserName,
			replaces,
		}
	},

	async update(
		id: string,
		_olds: InstanceCustomDomainOutputs,
		news: InstanceCustomDomainInputs,
	): Promise<pulumi.dynamic.UpdateResult<InstanceCustomDomainOutputs>> {
		// No-op against Zitadel: identity is immutable (see diff); other
		// fields only affect future auth. Persist new outs so Pulumi state
		// reflects the rotated key / changed System User name.
		return {
			outs: {
				...news,
				registeredId: id,
			},
		}
	},

	async delete(
		_id: string,
		state: InstanceCustomDomainOutputs,
	): Promise<void> {
		const profile: SystemUserProfile = {
			userName: state.systemUserName,
			privateKeyPem: state.privateKeyPem,
		}
		const res = await systemApiCall({
			domain: state.domain,
			profile,
			method: 'POST',
			path: '/zitadel.instance.v2.InstanceService/RemoveCustomDomain',
			body: {
				instanceId: state.instanceId,
				customDomain: state.customDomain,
			},
		})
		// 404 / NotFound is acceptable on delete (already gone). Anything
		// else 4xx/5xx is a real failure.
		if (res.statusCode === 404) return
		const body = res.body.toLowerCase()
		if (
			res.statusCode === 400 &&
			(body.includes('not_found') || body.includes('notfound'))
		) {
			return
		}
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Zitadel RemoveCustomDomain failed (${res.statusCode}): ${res.body}`,
			)
		}
	},
}

/**
 * Bake `privateKeyPem` into `additionalSecretOutputs` so the secret-output
 * contract cannot regress at any call site. `pulumi.secret(...)` inputs do
 * NOT auto-propagate across the dynamic-resource boundary: without this,
 * `outs: { ...inputs, registeredId }` in `create()` would land the private
 * key as plaintext in the Pulumi state checkpoint. Merge with caller-supplied
 * additions rather than overwrite. Mirrors the pattern from
 * `permanent-password.ts:mergeSecretOutputs`; the name is suffixed to avoid
 * a `dynamic/index.ts` barrel collision with that module's same-named helper.
 * Exported for unit-test coverage.
 */
export function mergeIcdSecretOutputs(
	opts?: pulumi.CustomResourceOptions,
): pulumi.CustomResourceOptions {
	return {
		...opts,
		additionalSecretOutputs: [
			'privateKeyPem',
			...(opts?.additionalSecretOutputs ?? []),
		],
	}
}

/**
 * `ZitadelInstanceCustomDomain` registers a hostname as an
 * `InstanceCustomDomain` on a Zitadel instance, making it a valid
 * `Host` header target for routing requests to that instance.
 *
 * Used by the `route-login-v2-via-internal-zitadel-api` change to add
 * `zitadel-api.zitadel.svc.cluster.local` so the Login UI's outbound
 * Connect-RPC calls can target the in-cluster Service URL instead of
 * the public LB hairpin (which 30s-timed-out on Node's HTTP client
 * through GCP HTTPS LB).
 *
 * Exists as a Dynamic Resource because `@pulumiverse/zitadel@0.2.0`
 * exposes neither `InstanceCustomDomain` as a resource nor a
 * `system_api` auth block on its `Provider`; the underlying
 * `instance.v2.AddCustomDomain` RPC requires `SYSTEM_OWNER` (proto
 * annotation: `system.domain.write`; comment: "cannot be called from
 * an instance context"), which the existing `pulumi-admin` IAM_OWNER
 * cannot satisfy.
 */
export class ZitadelInstanceCustomDomain extends pulumi.dynamic.Resource {
	public readonly registeredId!: pulumi.Output<string>

	constructor(
		name: string,
		args: ZitadelInstanceCustomDomainArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			instanceCustomDomainProvider,
			name,
			{
				...args,
				registeredId: undefined,
			},
			mergeIcdSecretOutputs(opts),
		)
	}
}
