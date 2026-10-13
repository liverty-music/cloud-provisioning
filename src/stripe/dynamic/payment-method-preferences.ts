import * as pulumi from '@pulumi/pulumi'
import { stripeApiCall, stripeErrorMessage } from './api-client.js'

/** Stripe's display preference for one payment method. */
export type PaymentMethodPreference = 'on' | 'off'

export interface StripePaymentMethodPreferencesArgs {
	/**
	 * Stripe secret key (`sk_test_…` for the sandbox the prod stack uses).
	 * Payment method configurations, like payment method domains, cannot be
	 * changed with a restricted key.
	 */
	apiKey: pulumi.Input<string>
	/**
	 * Display preference per payment method type, e.g.
	 * `{ apple_pay: 'on', google_pay: 'on' }`. Types not listed keep whatever
	 * the account has.
	 */
	preferences: pulumi.Input<Record<string, PaymentMethodPreference>>
}

interface PreferencesInputs {
	apiKey: string
	preferences: Record<string, PaymentMethodPreference>
}

interface PreferencesOutputs extends PreferencesInputs {
	configurationId: string
	/** Whether each listed payment method is offered, as Stripe reports it. */
	available: Record<string, boolean>
}

interface ConfigurationResponse {
	id: string
	is_default?: boolean
	[method: string]: unknown
}

interface MethodState {
	available?: boolean
	display_preference?: { preference?: string }
}

function ensureOk(
	res: { statusCode: number; body: string },
	operation: string,
): void {
	if (res.statusCode < 200 || res.statusCode >= 300) {
		throw new Error(
			`Stripe ${operation} failed (${res.statusCode}): ${stripeErrorMessage(res.body)}`,
		)
	}
}

function bodyOf(
	preferences: Record<string, PaymentMethodPreference>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(preferences).map(([method, preference]) => [
			method,
			{ display_preference: { preference } },
		]),
	)
}

/** The preferences and availability Stripe reports for the listed methods. */
function stateOf(
	config: ConfigurationResponse,
	methods: string[],
): {
	preferences: Record<string, PaymentMethodPreference>
	available: Record<string, boolean>
} {
	const preferences: Record<string, PaymentMethodPreference> = {}
	const available: Record<string, boolean> = {}
	for (const method of methods) {
		const state = (config[method] ?? {}) as MethodState
		preferences[method] =
			state.display_preference?.preference === 'on' ? 'on' : 'off'
		available[method] = state.available === true
	}
	return { preferences, available }
}

async function findDefaultConfiguration(apiKey: string): Promise<string> {
	const res = await stripeApiCall({
		apiKey,
		method: 'GET',
		path: '/v1/payment_method_configurations?limit=100',
	})
	ensureOk(res, 'ListPaymentMethodConfigurations')
	const list = JSON.parse(res.body) as { data?: ConfigurationResponse[] }
	const found = list.data?.find((config) => config.is_default)
	if (!found) {
		throw new Error(
			'Stripe ListPaymentMethodConfigurations returned no default configuration',
		)
	}
	return found.id
}

async function apply(
	apiKey: string,
	configurationId: string,
	preferences: Record<string, PaymentMethodPreference>,
): Promise<ConfigurationResponse> {
	const res = await stripeApiCall({
		apiKey,
		method: 'POST',
		path: `/v1/payment_method_configurations/${configurationId}`,
		body: bodyOf(preferences),
	})
	ensureOk(res, 'UpdatePaymentMethodConfiguration')
	return JSON.parse(res.body) as ConfigurationResponse
}

export const paymentMethodPreferencesProvider: pulumi.dynamic.ResourceProvider =
	{
		async create(
			inputs: PreferencesInputs,
		): Promise<pulumi.dynamic.CreateResult<PreferencesOutputs>> {
			const configurationId = await findDefaultConfiguration(
				inputs.apiKey,
			)
			const config = await apply(
				inputs.apiKey,
				configurationId,
				inputs.preferences,
			)
			return {
				id: configurationId,
				outs: {
					...inputs,
					configurationId,
					available: stateOf(config, Object.keys(inputs.preferences))
						.available,
				},
			}
		},

		async read(
			id: string,
			state: PreferencesOutputs,
		): Promise<pulumi.dynamic.ReadResult<PreferencesOutputs>> {
			const res = await stripeApiCall({
				apiKey: state.apiKey,
				method: 'GET',
				path: `/v1/payment_method_configurations/${id}`,
			})
			if (res.statusCode === 404) {
				return { id: undefined, props: undefined }
			}
			ensureOk(res, 'RetrievePaymentMethodConfiguration')
			const live = stateOf(
				JSON.parse(res.body) as ConfigurationResponse,
				Object.keys(state.preferences),
			)
			// Report what Stripe has, so a preference changed in the Dashboard
			// shows as a diff and the next up puts it back.
			return { id, props: { ...state, ...live } }
		},

		async diff(
			_id: string,
			olds: PreferencesOutputs,
			news: PreferencesInputs,
		): Promise<pulumi.dynamic.DiffResult> {
			const methods = new Set([
				...Object.keys(olds.preferences),
				...Object.keys(news.preferences),
			])
			const changed =
				olds.apiKey !== news.apiKey ||
				[...methods].some(
					(method) =>
						olds.preferences[method] !== news.preferences[method],
				)
			// The configuration is the account's default, so nothing is ever
			// replaced. A rotated API key is still a change: update stores it for
			// later reads (re-applying the same preferences is harmless).
			return {
				changes: changed,
				replaces: [],
				deleteBeforeReplace: false,
			}
		},

		async update(
			id: string,
			_olds: PreferencesOutputs,
			news: PreferencesInputs,
		): Promise<pulumi.dynamic.UpdateResult<PreferencesOutputs>> {
			const config = await apply(news.apiKey, id, news.preferences)
			return {
				outs: {
					...news,
					configurationId: id,
					available: stateOf(config, Object.keys(news.preferences))
						.available,
				},
			}
		},

		async delete(): Promise<void> {
			// The default configuration belongs to the Stripe account and cannot be
			// deleted. Removing this resource stops managing the preferences and
			// leaves them as they are.
		},
	}

/**
 * StripePaymentMethodPreferences sets display preferences on the Stripe
 * account's default payment method configuration, which decides the payment
 * methods a PaymentIntent created with `automatic_payment_methods` offers.
 * Google Pay is off by default on a new account, so without this the Payment
 * Element shows Card and Link only, even on a registered domain.
 */
export class StripePaymentMethodPreferences extends pulumi.dynamic.Resource {
	public readonly configurationId!: pulumi.Output<string>
	public readonly available!: pulumi.Output<Record<string, boolean>>

	constructor(
		name: string,
		args: StripePaymentMethodPreferencesArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			paymentMethodPreferencesProvider,
			name,
			{ ...args, configurationId: undefined, available: undefined },
			opts,
		)
	}
}
