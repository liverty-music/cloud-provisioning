import * as pulumi from '@pulumi/pulumi'
import { stripeApiCall, stripeErrorMessage } from './api-client.js'

export interface StripePaymentMethodDomainArgs {
	/**
	 * Stripe secret key (`sk_test_…` for the sandbox the prod stack uses).
	 * Payment method domains cannot be managed with a restricted key: Stripe
	 * answers that the permission is not available to restricted keys. The
	 * stack already holds this key for the fan-api, so no new credential is
	 * introduced.
	 */
	apiKey: pulumi.Input<string>
	/** The web domain that shows the wallet buttons, e.g. `liverty-music.app`. */
	domainName: pulumi.Input<string>
}

interface PaymentMethodDomainInputs {
	apiKey: string
	domainName: string
}

interface PaymentMethodDomainOutputs extends PaymentMethodDomainInputs {
	domainId: string
	/** Stripe's Apple Pay status for the domain: `active` or `inactive`. */
	applePayStatus: string
	/** Stripe's Google Pay status for the domain: `active` or `inactive`. */
	googlePayStatus: string
}

interface PaymentMethodDomainResponse {
	id: string
	domain_name: string
	enabled: boolean
	apple_pay?: { status?: string }
	google_pay?: { status?: string }
}

function outputsOf(
	inputs: PaymentMethodDomainInputs,
	domain: PaymentMethodDomainResponse,
): PaymentMethodDomainOutputs {
	return {
		...inputs,
		domainId: domain.id,
		applePayStatus: domain.apple_pay?.status ?? 'unknown',
		googlePayStatus: domain.google_pay?.status ?? 'unknown',
	}
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

/**
 * Finds an existing registration of domainName, enabled or not. Stripe keeps
 * a disabled registration (there is no delete), so create adopts it instead of
 * failing on a duplicate.
 */
async function findByDomainName(
	apiKey: string,
	domainName: string,
): Promise<PaymentMethodDomainResponse | undefined> {
	const res = await stripeApiCall({
		apiKey,
		method: 'GET',
		path: `/v1/payment_method_domains?domain_name=${encodeURIComponent(domainName)}&limit=1`,
	})
	ensureOk(res, 'ListPaymentMethodDomains')
	const list = JSON.parse(res.body) as {
		data?: PaymentMethodDomainResponse[]
	}
	return list.data?.[0]
}

export const paymentMethodDomainProvider: pulumi.dynamic.ResourceProvider = {
	async create(
		inputs: PaymentMethodDomainInputs,
	): Promise<pulumi.dynamic.CreateResult<PaymentMethodDomainOutputs>> {
		const existing = await findByDomainName(
			inputs.apiKey,
			inputs.domainName,
		)
		const res = existing
			? await stripeApiCall({
					apiKey: inputs.apiKey,
					method: 'POST',
					path: `/v1/payment_method_domains/${existing.id}`,
					body: { enabled: true },
				})
			: await stripeApiCall({
					apiKey: inputs.apiKey,
					method: 'POST',
					path: '/v1/payment_method_domains',
					body: { domain_name: inputs.domainName, enabled: true },
				})
		ensureOk(
			res,
			existing
				? 'UpdatePaymentMethodDomain'
				: 'CreatePaymentMethodDomain',
		)

		const domain = JSON.parse(res.body) as PaymentMethodDomainResponse
		return { id: domain.id, outs: outputsOf(inputs, domain) }
	},

	async read(
		id: string,
		state: PaymentMethodDomainOutputs,
	): Promise<pulumi.dynamic.ReadResult<PaymentMethodDomainOutputs>> {
		const res = await stripeApiCall({
			apiKey: state.apiKey,
			method: 'GET',
			path: `/v1/payment_method_domains/${id}`,
		})
		if (res.statusCode === 404) {
			return { id: undefined, props: undefined }
		}
		ensureOk(res, 'RetrievePaymentMethodDomain')
		const domain = JSON.parse(res.body) as PaymentMethodDomainResponse
		if (!domain.enabled) {
			// Disabled outside Pulumi: report absence so the next up enables it.
			return { id: undefined, props: undefined }
		}
		return { id, props: outputsOf(state, domain) }
	},

	async diff(
		_id: string,
		olds: PaymentMethodDomainOutputs,
		news: PaymentMethodDomainInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		// A new domain is a new registration. Rotating the API key changes only
		// how we authenticate and must not touch the registration.
		const replaces =
			olds.domainName !== news.domainName ? ['domainName'] : []
		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: false,
		}
	},

	async update(
		_id: string,
		olds: PaymentMethodDomainOutputs,
		news: PaymentMethodDomainInputs,
	): Promise<pulumi.dynamic.UpdateResult<PaymentMethodDomainOutputs>> {
		// Only the API key can change in place, and Stripe stores nothing for it.
		return { outs: { ...olds, apiKey: news.apiKey } }
	},

	async delete(id: string, state: PaymentMethodDomainOutputs): Promise<void> {
		// Stripe has no delete for payment method domains; disabling one hides the
		// wallet buttons on that domain, which is what removing it means here.
		const res = await stripeApiCall({
			apiKey: state.apiKey,
			method: 'POST',
			path: `/v1/payment_method_domains/${id}`,
			body: { enabled: false },
		})
		if (res.statusCode === 404) return
		ensureOk(res, 'UpdatePaymentMethodDomain')
	},
}

/**
 * StripePaymentMethodDomain registers a web domain with Stripe so the Payment
 * Element shows Apple Pay and Google Pay there. Stripe hides both wallet
 * buttons on unregistered domains without any error, and registrations are
 * per Stripe account (each sandbox and live mode separately), so they live
 * here in version control instead of in Dashboard state.
 */
export class StripePaymentMethodDomain extends pulumi.dynamic.Resource {
	public readonly domainId!: pulumi.Output<string>
	public readonly applePayStatus!: pulumi.Output<string>
	public readonly googlePayStatus!: pulumi.Output<string>

	constructor(
		name: string,
		args: StripePaymentMethodDomainArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			paymentMethodDomainProvider,
			name,
			{
				...args,
				domainId: undefined,
				applePayStatus: undefined,
				googlePayStatus: undefined,
			},
			opts,
		)
	}
}
