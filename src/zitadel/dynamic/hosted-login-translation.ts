import * as pulumi from '@pulumi/pulumi'
import { type JwtProfile, zitadelApiCall } from './api-client.js'

export interface ZitadelHostedLoginTranslationArgs {
	/** Zitadel domain, e.g. `auth.liverty-music.app`. */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON (stringified) for Settings v2 auth. */
	jwtProfileJson: pulumi.Input<string>
	/**
	 * Organization id to scope the override to (org-level translation). When
	 * omitted, the override is applied at instance level. Scoping to the
	 * product org keeps the admin/console org login unaffected.
	 */
	organizationId?: pulumi.Input<string>
	/** BCP 47 locale, e.g. `ja`. */
	locale: pulumi.Input<string>
	/**
	 * Full translation payload (Hosted Login translation schema, identical to
	 * the upstream `apps/login/locales/<locale>.json`). MUST be the COMPLETE
	 * key set: the Settings API English-fills any key omitted here, and the
	 * login app merges the API result OVER its bundled locale file, so a
	 * partial override leaves the un-supplied keys in English.
	 */
	translationsJson: pulumi.Input<string>
}

interface Inputs {
	domain: string
	jwtProfileJson: string
	organizationId?: string
	locale: string
	translationsJson: string
}

interface Outputs extends Inputs {
	/** sha256 of `translationsJson` so payload edits produce a clean diff. */
	translationsHash: string
	appliedAt: string
}

function sha256(s: string): string {
	const crypto = require('node:crypto') as typeof import('node:crypto')
	return crypto.createHash('sha256').update(s).digest('hex')
}

/** Build the SetHostedLoginTranslation request body (level oneof + payload). */
function buildBody(inputs: Inputs): Record<string, unknown> {
	const level = inputs.organizationId
		? { organizationId: inputs.organizationId }
		: { instance: true }
	return {
		...level,
		locale: inputs.locale,
		translations: JSON.parse(inputs.translationsJson) as unknown,
	}
}

async function setTranslation(inputs: Inputs): Promise<void> {
	const profile = JSON.parse(inputs.jwtProfileJson) as JwtProfile
	const res = await zitadelApiCall({
		domain: inputs.domain,
		profile,
		method: 'POST',
		path: '/zitadel.settings.v2.SettingsService/SetHostedLoginTranslation',
		body: buildBody(inputs),
	})
	if (res.statusCode < 200 || res.statusCode >= 300) {
		throw new Error(
			`Zitadel SetHostedLoginTranslation failed (${res.statusCode}): ${res.body}`,
		)
	}
}

/**
 * Provider for `ZitadelHostedLoginTranslation`. `SetHostedLoginTranslation`
 * is an idempotent upsert (it overwrites the stored translation for the given
 * level + locale), so `create` and `update` both POST the full payload.
 *
 * - `create()` / `update()` POST the complete translation payload.
 * - `delete()` is a no-op by design: removing the Pulumi record should not
 *   wipe the live override (mirrors `ZitadelSmtpActivation`). Retiring the
 *   override once upstream ships the language defaults (see OpenSpec change
 *   `fix-zitadel-login-ja-i18n`, exit condition) is a deliberate manual step.
 * - `read()` is a no-op returning current outputs; drift detection against the
 *   live translation is not needed — the payload hash drives diffs.
 */
export const hostedLoginTranslationProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: Inputs,
	): Promise<pulumi.dynamic.CreateResult<Outputs>> {
		await setTranslation(inputs)
		const idScope = inputs.organizationId ?? 'instance'
		return {
			id: `hosted-login-translation:${idScope}:${inputs.locale}`,
			outs: {
				...inputs,
				translationsHash: sha256(inputs.translationsJson),
				appliedAt: new Date().toISOString(),
			},
		}
	},

	async update(
		_id: string,
		_olds: Outputs,
		news: Inputs,
	): Promise<pulumi.dynamic.UpdateResult<Outputs>> {
		await setTranslation(news)
		return {
			outs: {
				...news,
				translationsHash: sha256(news.translationsJson),
				appliedAt: new Date().toISOString(),
			},
		}
	},

	async delete(_id: string, _state: Outputs): Promise<void> {
		// No-op by design — see class doc. Removing the resource record does
		// not clear the upstream override.
	},

	async read(
		id: string,
		state: Outputs,
	): Promise<pulumi.dynamic.ReadResult<Outputs>> {
		return { id, props: state }
	},
}

/**
 * `ZitadelHostedLoginTranslation` provisions a Zitadel Hosted Login Translation
 * override (Settings v2 `SetHostedLoginTranslation`) for a single locale.
 *
 * Why this exists: Zitadel's backend default hosted-login translations
 * (`internal/query/v2-default.json`) omit Japanese (and several other
 * languages present in the login app's `locales/`). For a missing language the
 * Settings API returns the instance default language (English), and the Login
 * UI v2 merges that API result OVER its own bundled `ja.json` — so the Japanese
 * login renders English. Seeding the full Japanese payload here makes the API
 * return Japanese, which the login app then renders. See OpenSpec change
 * `fix-zitadel-login-ja-i18n`. The upstream permanent fix is to add the missing
 * languages to `v2-default.json`; once a deployed Zitadel version ships that,
 * this resource can be removed.
 */
export class ZitadelHostedLoginTranslation extends pulumi.dynamic.Resource {
	public readonly translationsHash!: pulumi.Output<string>
	public readonly appliedAt!: pulumi.Output<string>

	constructor(
		name: string,
		args: ZitadelHostedLoginTranslationArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			hostedLoginTranslationProvider,
			name,
			{
				...args,
				translationsHash: undefined,
				appliedAt: undefined,
			},
			opts,
		)
	}
}
