import * as pulumi from '@pulumi/pulumi'
import { type JwtProfile, zitadelApiCall } from './api-client.js'

export type TargetType = 'REST_CALL' | 'REST_WEBHOOK' | 'REST_ASYNC'
export type PayloadType =
	| 'PAYLOAD_TYPE_JSON'
	| 'PAYLOAD_TYPE_JWT'
	| 'PAYLOAD_TYPE_JWE'

export interface ZitadelTargetArgs {
	/** Zitadel domain, e.g. `auth.dev.liverty-music.app`. */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON (stringified) for Management API auth. */
	jwtProfileJson: pulumi.Input<string>
	/** Unique display name for the Target. */
	name: pulumi.Input<string>
	/** Target webhook URL. Internal cluster DNS recommended for backend webhooks. */
	endpoint: pulumi.Input<string>
	/** Target flavor — REST_CALL (synchronous mutation), WEBHOOK (fire-and-forget), ASYNC. */
	targetType: pulumi.Input<TargetType>
	/** Request timeout in Go duration format, e.g. "10s". */
	timeout: pulumi.Input<string>
	/** Payload security mode. JWT is preferred — verifiable via Zitadel's JWKS. */
	payloadType: pulumi.Input<PayloadType>
	/** When true, target errors abort the Zitadel flow. Set false in dev for fallback. */
	interruptOnError?: pulumi.Input<boolean>
}

interface TargetInputs {
	domain: string
	jwtProfileJson: string
	name: string
	endpoint: string
	targetType: TargetType
	timeout: string
	payloadType: PayloadType
	interruptOnError: boolean
}

interface TargetOutputs extends TargetInputs {
	targetId: string
	signingKey?: string
}

const targetProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: TargetInputs,
	): Promise<pulumi.dynamic.CreateResult<TargetOutputs>> {
		const profile = JSON.parse(inputs.jwtProfileJson) as JwtProfile
		const wrapperKey =
			inputs.targetType === 'REST_CALL'
				? 'restCall'
				: inputs.targetType === 'REST_WEBHOOK'
					? 'restWebhook'
					: 'restAsync'
		const res = await zitadelApiCall({
			domain: inputs.domain,
			profile,
			method: 'POST',
			path: '/v2/actions/targets',
			body: {
				name: inputs.name,
				endpoint: inputs.endpoint,
				timeout: inputs.timeout,
				payloadType: inputs.payloadType,
				[wrapperKey]: {
					interruptOnError: inputs.interruptOnError,
				},
			},
		})
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Zitadel CreateTarget failed (${res.statusCode}): ${res.body}`,
			)
		}
		const parsed = JSON.parse(res.body) as {
			id: string
			signingKey?: string
		}
		return {
			id: parsed.id,
			outs: {
				...inputs,
				targetId: parsed.id,
				signingKey: parsed.signingKey,
			},
		}
	},

	async read(
		id: string,
		state: TargetOutputs,
	): Promise<pulumi.dynamic.ReadResult<TargetOutputs>> {
		const profile = JSON.parse(state.jwtProfileJson) as JwtProfile
		const res = await zitadelApiCall({
			domain: state.domain,
			profile,
			method: 'GET',
			path: `/v2/actions/targets/${id}`,
		})
		if (res.statusCode === 404) {
			return { id }
		}
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Zitadel ReadTarget failed (${res.statusCode}): ${res.body}`,
			)
		}
		return { id, props: state }
	},

	async update(
		id: string,
		_olds: TargetOutputs,
		news: TargetInputs,
	): Promise<pulumi.dynamic.UpdateResult<TargetOutputs>> {
		const profile = JSON.parse(news.jwtProfileJson) as JwtProfile
		const wrapperKey =
			news.targetType === 'REST_CALL'
				? 'restCall'
				: news.targetType === 'REST_WEBHOOK'
					? 'restWebhook'
					: 'restAsync'
		const res = await zitadelApiCall({
			domain: news.domain,
			profile,
			method: 'PATCH',
			path: `/v2/actions/targets/${id}`,
			body: {
				name: news.name,
				endpoint: news.endpoint,
				timeout: news.timeout,
				payloadType: news.payloadType,
				[wrapperKey]: {
					interruptOnError: news.interruptOnError,
				},
			},
		})
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Zitadel UpdateTarget failed (${res.statusCode}): ${res.body}`,
			)
		}
		return {
			outs: {
				...news,
				targetId: id,
			},
		}
	},

	async delete(id: string, state: TargetOutputs): Promise<void> {
		const profile = JSON.parse(state.jwtProfileJson) as JwtProfile
		const res = await zitadelApiCall({
			domain: state.domain,
			profile,
			method: 'DELETE',
			path: `/v2/actions/targets/${id}`,
		})
		if (
			res.statusCode !== 404 &&
			(res.statusCode < 200 || res.statusCode >= 300)
		) {
			throw new Error(
				`Zitadel DeleteTarget failed (${res.statusCode}): ${res.body}`,
			)
		}
	},
}

/**
 * ZitadelTarget manages a Zitadel Actions v2 Target (webhook endpoint) via
 * the Management REST API. Used where the `@pulumiverse/zitadel@0.2.0`
 * provider has no corresponding resource.
 */
export class ZitadelTarget extends pulumi.dynamic.Resource {
	public readonly targetId!: pulumi.Output<string>
	public readonly signingKey!: pulumi.Output<string | undefined>

	constructor(
		name: string,
		args: ZitadelTargetArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			targetProvider,
			name,
			{
				...args,
				interruptOnError: args.interruptOnError ?? false,
				targetId: undefined,
				signingKey: undefined,
			},
			opts,
		)
	}
}
