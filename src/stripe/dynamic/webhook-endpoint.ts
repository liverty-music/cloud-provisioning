import * as pulumi from '@pulumi/pulumi'
import { stripeApiCall, stripeErrorMessage } from './api-client.js'

export interface StripeWebhookEndpointArgs {
	/**
	 * Restricted Stripe API key (`rk_test_…` for the preprod sandbox the prod
	 * stack uses) with `Webhook Endpoints: write` and nothing else. Stripe recommends restricted keys over secret keys, and
	 * least privilege matters more than usual here: this credential lives in the
	 * Pulumi stack rather than in the application.
	 */
	apiKey: pulumi.Input<string>
	/** Public HTTPS URL Stripe delivers to, e.g. `https://api.liverty-music.app/stripe-webhook`. */
	url: pulumi.Input<string>
	/** Event types to subscribe to. Order-insensitive. */
	enabledEvents: pulumi.Input<string[]>
	/** Shown in the Stripe Dashboard so a human can tell endpoints apart. */
	description: pulumi.Input<string>
}

interface WebhookEndpointInputs {
	apiKey: string
	url: string
	enabledEvents: string[]
	description: string
}

interface WebhookEndpointOutputs extends WebhookEndpointInputs {
	endpointId: string
	/**
	 * The `whsec_…` signing secret. Stripe returns it **only** in the creation
	 * response, never on retrieve, so it is captured here and carried through
	 * updates. This is the whole point of provisioning the endpoint from IaC:
	 * the secret flows straight into the GSM secret ESO syncs, instead of being
	 * copied by hand out of the Dashboard.
	 */
	signingSecret: string
}

/** Sorted copy, so a reordered event list is not mistaken for a change. */
function normalizeEvents(events: string[]): string[] {
	return [...events].sort()
}

export const webhookEndpointProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: WebhookEndpointInputs,
	): Promise<pulumi.dynamic.CreateResult<WebhookEndpointOutputs>> {
		const res = await stripeApiCall({
			apiKey: inputs.apiKey,
			method: 'POST',
			path: '/v1/webhook_endpoints',
			body: {
				url: inputs.url,
				enabled_events: normalizeEvents(inputs.enabledEvents),
				description: inputs.description,
			},
		})
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Stripe CreateWebhookEndpoint failed (${res.statusCode}): ${stripeErrorMessage(res.body)}`,
			)
		}

		const created = JSON.parse(res.body) as {
			id: string
			secret?: string
		}
		if (!created.secret) {
			// Without the secret the backend handler can never verify a delivery,
			// and Stripe will not hand it out again. Fail loudly rather than
			// leaving a half-configured endpoint receiving events nobody can read.
			throw new Error(
				`Stripe CreateWebhookEndpoint returned no signing secret for ${created.id}; ` +
					'the endpoint cannot be verified and must be recreated',
			)
		}

		return {
			id: created.id,
			outs: {
				...inputs,
				enabledEvents: normalizeEvents(inputs.enabledEvents),
				endpointId: created.id,
				signingSecret: created.secret,
			},
		}
	},

	async read(
		id: string,
		state: WebhookEndpointOutputs,
	): Promise<pulumi.dynamic.ReadResult<WebhookEndpointOutputs>> {
		const res = await stripeApiCall({
			apiKey: state.apiKey,
			method: 'GET',
			path: `/v1/webhook_endpoints/${id}`,
		})
		if (res.statusCode === 404) {
			// Deleted outside Pulumi — report absence so the next up recreates it.
			return { id: undefined, props: undefined }
		}
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Stripe RetrieveWebhookEndpoint failed (${res.statusCode}): ${stripeErrorMessage(res.body)}`,
			)
		}

		const live = JSON.parse(res.body) as {
			url?: string
			enabled_events?: string[]
			description?: string | null
		}

		return {
			id,
			props: {
				...state,
				url: live.url ?? state.url,
				enabledEvents: normalizeEvents(
					live.enabled_events ?? state.enabledEvents,
				),
				description: live.description ?? state.description,
				endpointId: id,
				// Retrieve never returns the secret; keep the one from create.
				signingSecret: state.signingSecret,
			},
		}
	},

	async diff(
		_id: string,
		olds: WebhookEndpointOutputs,
		news: WebhookEndpointInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		// Rotating the API key changes only how we authenticate, not the endpoint
		// itself, so it must not force a replacement — replacing would mint a new
		// signing secret and break delivery until the backend picks it up.
		const replaces: string[] = []
		const changed =
			olds.url !== news.url ||
			olds.description !== news.description ||
			normalizeEvents(olds.enabledEvents).join(',') !==
				normalizeEvents(news.enabledEvents).join(',')

		return { changes: changed, replaces, deleteBeforeReplace: false }
	},

	async update(
		id: string,
		olds: WebhookEndpointOutputs,
		news: WebhookEndpointInputs,
	): Promise<pulumi.dynamic.UpdateResult<WebhookEndpointOutputs>> {
		const res = await stripeApiCall({
			apiKey: news.apiKey,
			method: 'POST',
			path: `/v1/webhook_endpoints/${id}`,
			body: {
				url: news.url,
				enabled_events: normalizeEvents(news.enabledEvents),
				description: news.description,
			},
		})
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(
				`Stripe UpdateWebhookEndpoint failed (${res.statusCode}): ${stripeErrorMessage(res.body)}`,
			)
		}

		return {
			outs: {
				...news,
				enabledEvents: normalizeEvents(news.enabledEvents),
				endpointId: id,
				// Update does not reissue the secret; preserve the original so an
				// in-place change never drops it.
				signingSecret: olds.signingSecret,
			},
		}
	},

	async delete(id: string, state: WebhookEndpointOutputs): Promise<void> {
		const res = await stripeApiCall({
			apiKey: state.apiKey,
			method: 'DELETE',
			path: `/v1/webhook_endpoints/${id}`,
		})
		// Already gone is success: a retried destroy must not fail.
		if (
			res.statusCode !== 404 &&
			(res.statusCode < 200 || res.statusCode >= 300)
		) {
			throw new Error(
				`Stripe DeleteWebhookEndpoint failed (${res.statusCode}): ${stripeErrorMessage(res.body)}`,
			)
		}
	},
}

/**
 * StripeWebhookEndpoint registers a Stripe webhook endpoint through the REST
 * API, following the same Dynamic Resource pattern as `src/zitadel/dynamic/`
 * for APIs no Pulumi provider covers.
 *
 * Provisioning it here rather than in the Dashboard means the `whsec_…` signing
 * secret never has to be copied between two consoles — it comes back in the
 * creation response and can be handed straight to the GSM secret ESO syncs —
 * and the subscribed event list lives in version control where it gets reviewed.
 *
 * Deleting this resource **deletes the endpoint at Stripe**, which stops
 * delivery of the dispute and refund events the settlement flow depends on.
 * Treat removing it, or renaming it in a way that changes its URN, as a
 * production change.
 */
export class StripeWebhookEndpoint extends pulumi.dynamic.Resource {
	public readonly endpointId!: pulumi.Output<string>
	public readonly signingSecret!: pulumi.Output<string>

	constructor(
		name: string,
		args: StripeWebhookEndpointArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			webhookEndpointProvider,
			name,
			{
				...args,
				endpointId: undefined,
				signingSecret: undefined,
			},
			// The signing secret is a credential: mark it secret so it is
			// encrypted in stack state and never printed in a diff.
			{ ...opts, additionalSecretOutputs: ['signingSecret'] },
		)
	}
}
