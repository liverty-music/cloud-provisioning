import * as pulumi from '@pulumi/pulumi'
import { type JwtProfile, zitadelApiCall } from './api-client.js'

export interface ZitadelHumanUserPasswordPermanentArgs {
	/** Zitadel domain, e.g. `auth.dev.liverty-music.app`. */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON (stringified) for Management API auth. */
	jwtProfileJson: pulumi.Input<string>
	/** ID of the `HumanUser` whose password should be marked permanent. */
	userId: pulumi.Input<string>
	/**
	 * The password to assert. The caller MUST pass the same value used in
	 * the `HumanUser.initialPassword` input; this resource has no way to
	 * read the password back from the HumanUser (it is a write-only field
	 * on the @pulumiverse/zitadel provider).
	 */
	password: pulumi.Input<string>
}

interface PermanentPasswordInputs {
	domain: string
	jwtProfileJson: string
	userId: string
	password: string
}

interface PermanentPasswordOutputs extends PermanentPasswordInputs {
	markedAt: string
}

/**
 * Provider for `ZitadelHumanUserPasswordPermanent`. Mirrors the lifecycle
 * shape of `smtp-activation.ts`: `create()` is the only handler that
 * touches Zitadel; `delete()` and `read()` are no-ops by design.
 *
 * Why no readback / no inverse verb:
 *
 * - Zitadel's Management API does not expose `GET /password/state`, so
 *   drift detection against `noChangeRequired` is not possible. Pulumi
 *   keeps the marker in state purely so subsequent `update()` calls can
 *   re-assert permanence on password rotation.
 * - There is no `_unset_permanent` verb either. Removing this marker
 *   resource should NOT flip the user back to `changeRequired = true`
 *   (the credential is still valid; only the next-sign-in gate would
 *   change), so `delete()` is a no-op.
 *
 * Why `update()` re-POSTs even with unchanged inputs:
 *
 * - Cheap (one token exchange + one POST) and gives drift recovery for
 *   free if an operator manually clears the permanence flag in the
 *   Zitadel admin console. The smtp-activation precedent takes the
 *   opposite stance because re-activating SMTP fires an email-rotation
 *   side-effect downstream; `SetPassword` has no equivalent side-effect.
 */
export const permanentPasswordProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: PermanentPasswordInputs,
	): Promise<pulumi.dynamic.CreateResult<PermanentPasswordOutputs>> {
		const profile = JSON.parse(inputs.jwtProfileJson) as JwtProfile
		const res = await zitadelApiCall({
			domain: inputs.domain,
			profile,
			method: 'POST',
			path: `/management/v1/users/${inputs.userId}/password`,
			body: {
				password: inputs.password,
				noChangeRequired: true,
			},
		})
		if (
			(res.statusCode < 200 || res.statusCode >= 300) &&
			!isAlreadyPermanent(res.body)
		) {
			throw new Error(
				`Zitadel SetHumanPassword failed (${res.statusCode}): ${res.body}`,
			)
		}
		return {
			id: `permanent-password:${inputs.userId}`,
			outs: {
				...inputs,
				markedAt: new Date().toISOString(),
			},
		}
	},

	async update(
		_id: string,
		olds: PermanentPasswordOutputs,
		news: PermanentPasswordInputs,
	): Promise<pulumi.dynamic.UpdateResult<PermanentPasswordOutputs>> {
		const profile = JSON.parse(news.jwtProfileJson) as JwtProfile
		const res = await zitadelApiCall({
			domain: news.domain,
			profile,
			method: 'POST',
			path: `/management/v1/users/${news.userId}/password`,
			body: {
				password: news.password,
				noChangeRequired: true,
			},
		})
		if (
			(res.statusCode < 200 || res.statusCode >= 300) &&
			!isAlreadyPermanent(res.body)
		) {
			throw new Error(
				`Zitadel SetHumanPassword (update) failed (${res.statusCode}): ${res.body}`,
			)
		}
		return {
			outs: {
				...news,
				// Preserve the original mark timestamp; the update is a
				// re-assertion, not a fresh mark.
				markedAt: olds.markedAt,
			},
		}
	},

	async delete(_id: string, _state: PermanentPasswordOutputs): Promise<void> {
		// No-op by design: there is no inverse Management API verb to
		// flip permanence off, and removing the marker resource should
		// not log the user out at the next sign-in. The HumanUser
		// resource is the source of truth for the user's existence.
	},

	async read(
		id: string,
		state: PermanentPasswordOutputs,
	): Promise<pulumi.dynamic.ReadResult<PermanentPasswordOutputs>> {
		// No-op: Zitadel exposes no GET endpoint for password permanence
		// state. Drift detection is explicitly out of scope (matches the
		// smtp-activation precedent).
		return { id, props: state }
	},
}

function isAlreadyPermanent(body: string): boolean {
	// Defensive: if Zitadel ever returns a non-2xx for the no-op case
	// (SetPassword called against an already-permanent password), accept
	// it as success. The exact response shape is verified during live
	// apply; today the happy path returns 200 regardless.
	return /no.?change/i.test(body) || /already.?permanent/i.test(body)
}

/**
 * `ZitadelHumanUserPasswordPermanent` marks a Zitadel `HumanUser`'s
 * password permanent (`noChangeRequired = true`) at provision time via
 * a `POST /management/v1/users/{user_id}/password` call. Without this
 * resource, every `@pulumiverse/zitadel.HumanUser` created with
 * `initialPassword` lands with `changeRequired = true` and the user
 * is redirected to `/ui/v2/login/password/change` on first sign-in
 * (the provider v0.2.0 exposes no knob to flip this flag at create
 * time).
 *
 * The caller MUST pass the same password value used for the HumanUser's
 * `initialPassword` input — the resource cannot read it back from the
 * upstream provider.
 *
 * See OpenSpec change `zitadel-permanent-password` for the full
 * decision record (D1–D5) and risk table.
 */
/**
 * Bake `password` + `jwtProfileJson` into `additionalSecretOutputs` so the
 * secret-output contract cannot regress at any call site. `pulumi.secret(...)`
 * inputs do NOT auto-propagate across the dynamic-resource boundary: without
 * this, `outs: { ...inputs, markedAt }` in `create()` would land both as
 * plaintext in the Pulumi state checkpoint. Merge with caller-supplied
 * additions rather than overwrite. Exported for unit-test coverage.
 */
export function mergeSecretOutputs(
	opts?: pulumi.CustomResourceOptions,
): pulumi.CustomResourceOptions {
	return {
		...opts,
		additionalSecretOutputs: [
			'password',
			'jwtProfileJson',
			...(opts?.additionalSecretOutputs ?? []),
		],
	}
}

export class ZitadelHumanUserPasswordPermanent extends pulumi.dynamic.Resource {
	public readonly markedAt!: pulumi.Output<string>

	constructor(
		name: string,
		args: ZitadelHumanUserPasswordPermanentArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			permanentPasswordProvider,
			name,
			{
				...args,
				markedAt: undefined,
			},
			mergeSecretOutputs(opts),
		)
	}
}
