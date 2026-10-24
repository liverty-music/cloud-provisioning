import * as cloudflare from '@pulumi/cloudflare'
import * as posthog from '@pulumi/posthog'
import * as pulumi from '@pulumi/pulumi'
import type { CloudflareConfig } from '../../cloudflare/config.js'

/** PostHog EU Cloud, where the prod project lives. */
const POSTHOG_HOST = 'https://eu.posthog.com'

/** The PostHog organization that owns the prod project. */
const ORGANIZATION_ID = '019e7b58-75ff-0000-79de-62f6f9ec2075'

/** The prod PostHog project ("liverty-music-prod"). */
const PROJECT_ID = '190464'

/**
 * Subdomain of the managed reverse proxy. A plain word with no analytics
 * meaning: blockers list hosts named `analytics`, `tracking`, `telemetry`,
 * `posthog`, `ph` or `metrics` (PostHog, "Pick a boring subdomain").
 */
const PROXY_SUBDOMAIN = 'beat'

export interface ProductAnalyticsArgs {
	/** Project-scoped PostHog personal API key (`project:write`, project 190464). */
	apiKey: pulumi.Input<string>
	/**
	 * Organization-level PostHog personal API key (`organization:write` only)
	 * for the proxy record, which a project-scoped key cannot create. When
	 * absent, the proxy and its CNAME are not managed.
	 */
	organizationApiKey?: pulumi.Input<string>
	/** Apex domain of the fan app (`liverty-music.app`). */
	publicDomain: string
	cloudflareConfig: CloudflareConfig
}

/**
 * The fan app's PostHog project and its managed reverse proxy (OpenSpec
 * `expand-product-analytics`, tasks 5.1 and 5.3):
 *
 * - the project, imported, with its day boundary in Japan time;
 * - a managed reverse proxy on `beat.<publicDomain>`, so events and recordings
 *   reach PostHog through the app's own domain;
 * - the proxy's CNAME in Cloudflare, DNS-only: PostHog issues the certificate,
 *   which Cloudflare's own proxy would break.
 * - the North Star insight (OpenSpec `build-analytics-warehouse`).
 *
 * The recording URL blocklist has no provider field and stays manual; see
 * docs/runbooks/posthog-project-settings.md. The fan app's `posthogApiHost`
 * moves to the proxy only once its status is valid.
 */
export class ProductAnalytics extends pulumi.ComponentResource {
	public readonly proxyHost: pulumi.Output<string> | undefined

	constructor(
		name: string,
		args: ProductAnalyticsArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('liverty-music:posthog:ProductAnalytics', name, {}, opts)

		const provider = new posthog.Provider(
			`${name}-provider`,
			{
				apiKey: args.apiKey,
				host: POSTHOG_HOST,
				organizationId: ORGANIZATION_ID,
				projectId: PROJECT_ID,
			},
			{ parent: this },
		)

		// Holds every event and recording of the fan app: protected so no plan
		// can delete or replace it. Day boundaries of every insight follow the
		// fans' time zone.
		new posthog.Project(
			`${name}-project`,
			{
				name: 'liverty-music-prod',
				organizationId: ORGANIZATION_ID,
				timezone: 'Asia/Tokyo',
			},
			{
				parent: this,
				provider,
				protect: true,
				import: `${ORGANIZATION_ID}/${PROJECT_ID}`,
			},
		)

		// The North Star (OpenSpec `build-analytics-warehouse`): fans who opened
		// a new-concert notification, per week. The service worker reports the
		// message's `type` on `notification.opened`.
		new posthog.Insight(
			`${name}-north-star`,
			{
				name: 'North Star: fans who opened a new-concert notification',
				description:
					'Unique persons per week with notification.opened where type = new_concerts. ' +
					'Test accounts excluded. See docs/runbooks/analytics-dashboards.md.',
				queryJson: JSON.stringify({
					kind: 'InsightVizNode',
					source: {
						kind: 'TrendsQuery',
						interval: 'week',
						dateRange: { date_from: '-180d' },
						filterTestAccounts: true,
						series: [
							{
								kind: 'EventsNode',
								event: 'notification.opened',
								math: 'dau',
								properties: [
									{
										key: 'type',
										operator: 'exact',
										type: 'event',
										value: ['new_concerts'],
									},
								],
							},
						],
						trendsFilter: { display: 'ActionsLineGraph' },
					},
				}),
				tags: ['north-star'],
			},
			{ parent: this, provider },
		)

		this.proxyHost =
			args.organizationApiKey === undefined
				? undefined
				: this.proxy(name, args, args.organizationApiKey)
		this.registerOutputs({ proxyHost: this.proxyHost })
	}

	/** The managed reverse proxy and its CNAME; returns the proxy's URL. */
	private proxy(
		name: string,
		args: ProductAnalyticsArgs,
		organizationApiKey: pulumi.Input<string>,
	): pulumi.Output<string> {
		const provider = new posthog.Provider(
			`${name}-organization-provider`,
			{
				apiKey: organizationApiKey,
				host: POSTHOG_HOST,
				organizationId: ORGANIZATION_ID,
			},
			{ parent: this },
		)
		const domain = `${PROXY_SUBDOMAIN}.${args.publicDomain}`
		const proxy = new posthog.ProxyRecord(
			`${name}-proxy`,
			{ organizationId: ORGANIZATION_ID, domain },
			{ parent: this, provider },
		)

		const cloudflareProvider = new cloudflare.Provider(
			`${name}-cloudflare-provider`,
			{ apiToken: args.cloudflareConfig.apiToken },
			{ parent: this },
		)
		new cloudflare.DnsRecord(
			`${name}-proxy-cname`,
			{
				zoneId: args.cloudflareConfig.zoneId,
				name: PROXY_SUBDOMAIN,
				type: 'CNAME',
				content: proxy.targetCname,
				ttl: 300,
				proxied: false,
				comment: `PostHog managed reverse proxy for ${domain}`,
			},
			{ parent: this, provider: cloudflareProvider },
		)
		return pulumi.output(`https://${domain}`)
	}
}
