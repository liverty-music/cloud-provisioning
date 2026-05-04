import * as pulumi from '@pulumi/pulumi'
import { type JwtProfile, zitadelApiCall } from './api-client.js'

export interface ZitadelSmtpActivationArgs {
	/** Zitadel domain, e.g. `auth.dev.liverty-music.app`. */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON (stringified) for Management API auth. */
	jwtProfileJson: pulumi.Input<string>
	/** ID of the `SmtpConfig` resource to activate. */
	smtpConfigId: pulumi.Input<string>
}

interface SmtpActivationInputs {
	domain: string
	jwtProfileJson: string
	smtpConfigId: string
}

interface SmtpActivationOutputs extends SmtpActivationInputs {
	activatedAt: string
}

/**
 * Provider for `ZitadelSmtpActivation`. Diverges from the standard four-case
 * Dynamic Resource lifecycle (create/read/update/delete) because activation
 * is a one-shot side effect at the Zitadel REST surface — there is no
 * `GET /admin/v1/smtp/{id}/_activation` to read, no separate `_deactivate`
 * verb to call on delete, and the only meaningful input
 * (`smtpConfigId`) is a hard identity tied to the `SmtpConfig` resource.
 *
 * ## Why we discover the activation id at runtime instead of using `inputs.smtpConfigId`
 *
 * `@pulumiverse/zitadel.SmtpConfig` (v0.2.0) returns the IAM org id as the
 * Pulumi resource id (a holdover from Zitadel v3 when there was only ever
 * one SMTP config per instance, so org id == "the SMTP id"). Zitadel v4
 * introduced multi-config SMTP and assigns each config its own snowflake
 * id; the activation endpoint requires that real id, not the IAM org id.
 * Calling `/admin/v1/smtp/{org-id}/_activate` against a v4 instance returns
 * 404 "SMTP configuration not found".
 *
 * Workaround: ignore `inputs.smtpConfigId` for the API call, instead
 * `_search` for the SMTP config and activate the single result. The
 * `smtpConfigId` input is retained as a Pulumi-graph dependency marker so
 * activation only runs after the `SmtpConfig` resource has been created;
 * its value is recorded in outputs for diff stability.
 *
 * Limitation: assumes exactly one SMTP config per instance, which matches
 * the current `liverty-music` setup. If multi-config support is added
 * later, this needs a sender-address or display-name filter.
 *
 * - `create()` discovers the real config id, then POSTs
 *   `/admin/v1/smtp/{realId}/_activate`. Treats the upstream "already
 *   active" response as success (idempotency) so the first apply against
 *   a manually-activated SMTP does not stall the stack.
 * - `update()` is a no-op. Re-firing `_activate` would be a side effect
 *   without any state change, and there are no other inputs to update.
 * - `delete()` is a no-op. Removing the Pulumi resource record from state
 *   should not deactivate the upstream SMTP — drift handling is explicitly
 *   deferred per `cutover-warning-fixes` design D2.
 * - `read()` is a no-op returning current outputs unchanged.
 */
export const smtpActivationProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: SmtpActivationInputs,
	): Promise<pulumi.dynamic.CreateResult<SmtpActivationOutputs>> {
		const profile = JSON.parse(inputs.jwtProfileJson) as JwtProfile
		// Step 1: discover the real SMTP config id (provider workaround).
		const search = await zitadelApiCall({
			domain: inputs.domain,
			profile,
			method: 'POST',
			path: '/admin/v1/smtp/_search',
			body: {},
		})
		if (search.statusCode < 200 || search.statusCode >= 300) {
			throw new Error(
				`Zitadel SearchSmtpConfigs failed (${search.statusCode}): ${search.body}`,
			)
		}
		const searchResult = JSON.parse(search.body) as {
			result?: Array<{ id: string; state?: string }>
		}
		const configs = searchResult.result ?? []
		if (configs.length === 0) {
			throw new Error(
				'Zitadel SearchSmtpConfigs returned 0 configs; cannot activate ' +
					'(`SmtpConfig` resource may not have settled yet — Pulumi ' +
					'graph dependency on `smtpConfigId` should make this race ' +
					'impossible, please report)',
			)
		}
		if (configs.length > 1) {
			throw new Error(
				`Zitadel SearchSmtpConfigs returned ${configs.length} configs; ` +
					'this provider workaround assumes exactly one SMTP config ' +
					'per instance. Add a sender-address filter to disambiguate.',
			)
		}
		const realId = configs[0].id
		// Step 2: activate using the real id.
		const res = await zitadelApiCall({
			domain: inputs.domain,
			profile,
			method: 'POST',
			path: `/admin/v1/smtp/${realId}/_activate`,
		})
		// 2xx covers the happy path. Zitadel returns the same shape for
		// "newly activated" and "already active" cases on this endpoint
		// (empirically verified during the cutover smoke test), so any 2xx
		// is success. A non-2xx with an "already active" code in the body
		// is treated as success too — see `isAlreadyActive`.
		if (
			(res.statusCode < 200 || res.statusCode >= 300) &&
			!isAlreadyActive(res.body)
		) {
			throw new Error(
				`Zitadel ActivateSmtpConfig failed (${res.statusCode}): ${res.body}`,
			)
		}
		return {
			id: `smtp-activation:${realId}`,
			outs: {
				...inputs,
				activatedAt: new Date().toISOString(),
			},
		}
	},

	async update(
		_id: string,
		olds: SmtpActivationOutputs,
		news: SmtpActivationInputs,
	): Promise<pulumi.dynamic.UpdateResult<SmtpActivationOutputs>> {
		// No-op by design: the only meaningful input is `smtpConfigId`,
		// which is a hard identity (Pulumi triggers `replace`, not `update`,
		// when it changes). Anything reaching `update` is an input shape
		// other than `smtpConfigId` (none exist today) and is therefore
		// nothing to apply against the upstream API. Preserve `activatedAt`
		// from `olds` so subsequent diffs stay clean.
		return {
			outs: {
				...news,
				activatedAt: olds.activatedAt,
			},
		}
	},

	async delete(_id: string, _state: SmtpActivationOutputs): Promise<void> {
		// No-op by design: removing the Pulumi resource record should not
		// deactivate the upstream SMTP. There is also no `_deactivate`
		// admin endpoint we want to call here. If true drift handling is
		// needed later, it should live elsewhere (see design D2 Risks).
	},

	async read(
		id: string,
		state: SmtpActivationOutputs,
	): Promise<pulumi.dynamic.ReadResult<SmtpActivationOutputs>> {
		// No-op: there is no per-activation GET endpoint. Drift detection
		// against `SmtpConfig.state == SMTP_CONFIG_ACTIVE` is explicitly
		// deferred per design D2.
		return { id, props: state }
	},
}

function isAlreadyActive(body: string): boolean {
	// Zitadel returns a code/message envelope on errors; the
	// "already active" state surfaces with a recognizable token.
	// Match conservatively to avoid swallowing unrelated failures.
	return /already.?active/i.test(body) || /SMTP_CONFIG_ACTIVE/.test(body)
}

/**
 * `ZitadelSmtpActivation` activates a Zitadel `SmtpConfig` so SMTP traffic
 * can flow. Without this resource, every Zitadel rebuild silently leaves
 * SMTP `INACTIVE` (the `@pulumiverse/zitadel.SmtpConfig` v0.2.0 resource
 * provisions configuration but does not call the separate `_activate`
 * admin endpoint), and first-sign-up email verification fails until an
 * operator runs `curl POST /admin/v1/smtp/{id}/_activate` manually.
 *
 * Reactivation is idempotent: the upstream returns success when called
 * against an already-active SMTP, so this resource may be safely created
 * after a manual activation.
 */
export class ZitadelSmtpActivation extends pulumi.dynamic.Resource {
	public readonly activatedAt!: pulumi.Output<string>

	constructor(
		name: string,
		args: ZitadelSmtpActivationArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			smtpActivationProvider,
			name,
			{
				...args,
				activatedAt: undefined,
			},
			opts,
		)
	}
}
