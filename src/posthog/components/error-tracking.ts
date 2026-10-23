import * as posthog from '@pulumi/posthog'
import * as pulumi from '@pulumi/pulumi'

/** PostHog EU Cloud, where the prod project lives. */
const POSTHOG_HOST = 'https://eu.posthog.com'

/** The prod PostHog project ("liverty-music-prod"). */
const PROJECT_ID = '190464'

/**
 * The project's Slack integration. The integration itself (the OAuth install of
 * the PostHog app) is made in the PostHog UI and is not a provider resource, so
 * it is referenced by id.
 */
const SLACK_INTEGRATION_ID = 83774

/**
 * `#alert-frontend-prod`, by id so a channel rename does not break delivery.
 * The PostHog app must be a member of the channel.
 */
const ALERT_CHANNEL_ID = 'C0CBL2URPA6'
const ALERT_CHANNEL_NAME = '#alert-frontend-prod'

export interface ErrorTrackingArgs {
	/**
	 * PostHog personal API key the provider authenticates with
	 * (`hog_function:write`, `project:write`, limited to project 190464).
	 */
	apiKey: pulumi.Input<string>
}

/** The issue lifecycle events an alert can fire on. */
type IssueEvent =
	| '$error_tracking_issue_created'
	| '$error_tracking_issue_reopened'

/**
 * A Slack alert for one issue lifecycle event. The message body is PostHog's
 * own layout for these alerts (the in-product alert wizard's), so a codified
 * alert reads the same as one made in the UI. The `{…}` segments are Hog
 * templates evaluated when the alert fires.
 */
function slackAlertInputs(event: IssueEvent): string {
	const created = event === '$error_tracking_issue_created'
	const issueUrl =
		'{project.url}/error-tracking/fingerprint/{encodeURLComponent(event.properties.fingerprint)}?timestamp={event.properties.exception_timestamp}&utm_source=alert&utm_campaign=error_tracking_alert&utm_medium=slack'
	return JSON.stringify({
		slack_workspace: { value: SLACK_INTEGRATION_ID },
		channel: { value: ALERT_CHANNEL_ID },
		text: {
			value: created
				? 'New issue created: {event.properties.name}'
				: 'Issue reopened: {event.properties.name}',
		},
		blocks: {
			value: [
				{
					type: 'header',
					text: {
						type: 'plain_text',
						text: `${created ? '🔴' : '🔄'} {event.properties.name}`,
					},
				},
				{
					type: 'section',
					text: {
						type: 'plain_text',
						text: created ? 'New issue created' : 'Issue reopened',
					},
				},
				{
					type: 'section',
					text: {
						type: 'mrkdwn',
						text: '```{substring(event.properties.description, 1, 150)}```',
					},
				},
				{
					type: 'context',
					elements: [
						{
							type: 'plain_text',
							text: 'Status: {event.properties.status}',
						},
						{
							type: 'mrkdwn',
							text: 'Project: <{project.url}|{project.name}>',
						},
						{
							type: 'mrkdwn',
							text: 'Alert: <{source.url}|{source.name}>',
						},
					],
				},
				{ type: 'divider' },
				{
					type: 'actions',
					elements: [
						{
							type: 'button',
							text: { type: 'plain_text', text: 'View Issue' },
							url: issueUrl,
						},
					],
				},
			],
		},
	})
}

/**
 * ErrorTracking declares the fan app's PostHog Error Tracking settings that the
 * provider can manage (OpenSpec `capture-client-errors`, design D10):
 *
 * - exception autocapture stays off at the project, so the only capture path is
 *   the app's own `captureException`, which carries the banner's Error ID;
 * - a new issue and a reopened issue each post to `#alert-frontend-prod`.
 *
 * The error-tracking billing limit and rate limits have no provider resource
 * and stay manual; see docs/runbooks/frontend-error-tracking.md.
 */
export class ErrorTracking extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: ErrorTrackingArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('liverty-music:posthog:ErrorTracking', name, {}, opts)

		const provider = new posthog.Provider(
			`${name}-provider`,
			{ apiKey: args.apiKey, host: POSTHOG_HOST, projectId: PROJECT_ID },
			{ parent: this },
		)
		const childOpts = { parent: this, provider }

		new posthog.ProjectSettings(
			`${name}-project-settings`,
			{ projectId: PROJECT_ID, autocaptureExceptionsOptIn: false },
			childOpts,
		)

		const alerts: { key: string; event: IssueEvent; label: string }[] = [
			{
				key: 'issue-created',
				event: '$error_tracking_issue_created',
				label: 'Issue created',
			},
			{
				key: 'issue-reopened',
				event: '$error_tracking_issue_reopened',
				label: 'Issue reopened',
			},
		]
		for (const alert of alerts) {
			new posthog.HogFunction(
				`${name}-${alert.key}-alert`,
				{
					projectId: PROJECT_ID,
					type: 'internal_destination',
					templateId: 'template-slack',
					name: `${alert.label} · ${ALERT_CHANNEL_NAME}`,
					enabled: true,
					filtersJson: JSON.stringify({
						events: [{ id: alert.event, type: 'events' }],
					}),
					inputsJson: slackAlertInputs(alert.event),
				},
				childOpts,
			)
		}

		this.registerOutputs({})
	}
}
