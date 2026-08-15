import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'

/** Backend workload definition for alert policy creation. */
interface Workload {
	/** Display name used in the alert policy title. */
	displayName: string
	/** Value of the k8s-pod/app label used in the log filter. */
	appLabel: string
}

export interface MonitoringComponentArgs {
	project: gcp.organizations.Project
	/**
	 * Notification channel IDs for backend error log alerts, created via GCP Console.
	 *
	 * Slack notification channels must be created manually through the GCP Console
	 * because the API requires an OAuth flow with Slack that cannot be performed
	 * via IaC tools (Pulumi/Terraform).
	 */
	slackNotificationChannelIds: string[]
	/**
	 * Google Chat space IDs for alert notifications.
	 * Each space ID is used to create a NotificationChannel resource (type: google_chat).
	 * The Google Cloud Monitoring app must be installed in each Chat space beforehand.
	 */
	googleChatSpaceIds?: string[]
	/** GKE cluster location (e.g., "asia-northeast2"). */
	clusterLocation: string
	/** GKE cluster name (e.g., "cluster-osaka"). */
	clusterName: string
}

/**
 * MonitoringComponent provisions Cloud Monitoring log-based alert policies
 * for backend workload ERROR log detection.
 *
 * Slack Notification Channels must be created beforehand via GCP Console
 * and their channel IDs passed in as `slackNotificationChannelIds`.
 *
 * Google Chat Notification Channels are created as Pulumi resources
 * using the space IDs passed in as `googleChatSpaceIds`.
 */
export class MonitoringComponent extends pulumi.ComponentResource {
	public readonly alertPolicies: gcp.monitoring.AlertPolicy[]
	public readonly atlasMigrationAlertPolicy: gcp.monitoring.AlertPolicy
	public readonly consumerBacklogAlertPolicy: gcp.monitoring.AlertPolicy
	public readonly googleChatChannels: gcp.monitoring.NotificationChannel[]
	public readonly salesReminderDeliveryMetric: gcp.logging.Metric
	public readonly webPushDeliveryFailureMetric: gcp.logging.Metric
	public readonly webPushDeliveryFailureAlertPolicy: gcp.monitoring.AlertPolicy
	public readonly webPushSubscriptionStarvationAlertPolicy: gcp.monitoring.AlertPolicy

	constructor(
		name: string,
		args: MonitoringComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:MonitoringComponent', name, args, opts)

		const {
			project,
			slackNotificationChannelIds,
			googleChatSpaceIds,
			clusterLocation,
			clusterName,
		} = args

		const projectId = project.projectId

		// Slack channels (referenced by ID, created via GCP Console)
		const slackChannels = slackNotificationChannelIds.map(
			(id) =>
				pulumi.interpolate`projects/${projectId}/notificationChannels/${id}`,
		)

		// Google Chat channels (created as Pulumi resources)
		this.googleChatChannels = (googleChatSpaceIds ?? []).map(
			(spaceId) =>
				new gcp.monitoring.NotificationChannel(
					'notification-channel-google-chat-alert-backend',
					{
						project: projectId,
						type: 'google_chat',
						displayName: 'Google Chat Alert Backend',
						labels: {
							space: `spaces/${spaceId}`,
						},
					},
					{ parent: this },
				),
		)

		const notificationChannels = [
			...slackChannels,
			...this.googleChatChannels.map((ch) => ch.name),
		]

		// Log-Based Alert Policies (one per workload)
		const workloads: Workload[] = [
			{ displayName: 'Server', appLabel: 'server' },
			{ displayName: 'Consumer', appLabel: 'consumer' },
			{
				displayName: 'Concert Discovery',
				appLabel: 'concert-discovery',
			},
			{
				displayName: 'Sales Phase Discovery',
				appLabel: 'sales-phase-discovery',
			},
			{
				displayName: 'Merch Discovery',
				appLabel: 'merch-discovery',
			},
		]

		this.alertPolicies = workloads.map(
			(workload) =>
				new gcp.monitoring.AlertPolicy(
					`alert-error-log-${workload.appLabel}`,
					{
						displayName: `${workload.displayName} ERROR Log`,
						project: projectId,
						combiner: 'OR',
						conditions: [
							{
								displayName: `${workload.displayName} error log detected`,
								conditionMatchedLog: {
									filter: pulumi.interpolate`resource.type="k8s_container"
resource.labels.project_id="${projectId}"
resource.labels.location="${clusterLocation}"
resource.labels.cluster_name="${clusterName}"
resource.labels.namespace_name="backend"
labels.k8s-pod/app="${workload.appLabel}"
severity="ERROR"`,
									labelExtractors: {
										error_code:
											'EXTRACT(jsonPayload.error.code)',
										rpc_method:
											'EXTRACT(jsonPayload.rpc_method)',
									},
								},
							},
						],
						alertStrategy: {
							notificationRateLimit: {
								period: '43200s', // 12 hours
							},
							autoClose: '3600s', // 1 hour
						},
						notificationChannels,
						documentation: {
							content: [
								`## ${workload.displayName} ERROR Log Alert`,
								'',
								'An ERROR-level log entry was detected in the backend application.',
								'',
								'### Triage Steps',
								'1. Check the linked Cloud Logging entry for the full error details',
								'2. Look at `error_code` and `rpc_method` labels in this alert for quick context',
								'3. Search for related logs using the `trace_id` from the log entry',
							].join('\n'),
							mimeType: 'text/markdown',
						},
					},
					{ parent: this },
				),
		)

		// Poison Queue Accumulation Alert
		// Fires when the PoisonConsumer logs an ERROR for a dead-lettered message.
		// This is a secondary safety net: the consumer workload alert above also
		// fires on any consumer ERROR, but this policy is scoped to poison queue
		// events specifically to aid triage.
		const poisonQueueAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-poison-queue-message',
			{
				displayName: 'Consumer Poison Queue Message',
				project: projectId,
				combiner: 'OR',
				conditions: [
					{
						displayName: 'Message routed to poison queue',
						conditionMatchedLog: {
							filter: pulumi.interpolate`resource.type="k8s_container"
resource.labels.project_id="${projectId}"
resource.labels.location="${clusterLocation}"
resource.labels.cluster_name="${clusterName}"
resource.labels.namespace_name="backend"
labels.k8s-pod/app="consumer"
severity="ERROR"
jsonPayload.msg="message routed to poison queue"`,
							labelExtractors: {
								topic: 'EXTRACT(jsonPayload.topic)',
								uuid: 'EXTRACT(jsonPayload.uuid)',
							},
						},
					},
				],
				alertStrategy: {
					notificationRateLimit: {
						period: '43200s', // 12 hours
					},
					autoClose: '3600s', // 1 hour
				},
				notificationChannels,
				documentation: {
					content: [
						'## Consumer Poison Queue Message Alert',
						'',
						'A message was routed to the NATS Poison Queue after exhausting all Watermill retries.',
						'This means a consumer handler failed permanently for this message.',
						'',
						'### Alert Labels',
						'- `topic`: The original NATS subject the message was published to',
						'- `uuid`: The Watermill message UUID for correlation in Cloud Logging',
						'',
						'### Triage Steps',
						"1. Find the original handler failure: search Cloud Logging for the message `uuid` to find earlier ERROR/WARN logs from that message's processing",
						'2. Check the `topic` label to identify which handler failed (e.g., `USER.created` → email verification)',
						'3. Investigate the root cause (external API outage, misconfiguration, bad message payload)',
						'4. If the message needs to be re-processed, use `nats stream get POISON <seq>` to inspect and manually republish to the original topic',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)
		this.alertPolicies.push(poisonQueueAlertPolicy)

		// Atlas Operator Migration Failure Alert
		this.atlasMigrationAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-atlas-migration-failure',
			{
				displayName: 'Atlas Operator Migration Failure',
				project: projectId,
				combiner: 'OR',
				conditions: [
					{
						displayName:
							'Atlas migration TransientErr or BackoffLimitExceeded detected',
						conditionMatchedLog: {
							filter: pulumi.interpolate`resource.type="k8s_container"
resource.labels.project_id="${projectId}"
resource.labels.location="${clusterLocation}"
resource.labels.cluster_name="${clusterName}"
resource.labels.namespace_name="atlas-operator"
resource.labels.container_name="manager"
jsonPayload.reason=~"TransientErr|BackoffLimitExceeded"`,
						},
					},
				],
				alertStrategy: {
					notificationRateLimit: {
						period: '43200s', // 12 hours
					},
					autoClose: '3600s', // 1 hour
				},
				notificationChannels,
				documentation: {
					content: [
						'## Atlas Operator Migration Failure Alert',
						'',
						'The Atlas Operator detected a migration failure in the `atlas-operator` namespace.',
						'This typically means a schema migration could not be applied to the database.',
						'',
						'### Common Failure Reasons',
						'- **TransientErr**: Migration failed due to a transient error (e.g., out-of-order migration files, SQL syntax error, connection timeout)',
						'- **BackoffLimitExceeded**: The operator exhausted all retry attempts after repeated TransientErr failures',
						'',
						'### Triage Steps',
						'1. Check the linked Cloud Logging entry for the full error message in `jsonPayload`',
						'2. Look at the `AtlasMigration` resource status: `kubectl -n atlas-operator describe atlasmigration backend-migration`',
						'3. Check the migration pod logs: `kubectl -n atlas-operator logs -l app.kubernetes.io/name=atlas-operator`',
						'4. If the error is "non-linear" (out-of-order files), see: https://atlasgo.io/versioned/apply#non-linear-error',
						'5. After fixing the root cause, the operator will automatically retry on the next reconciliation cycle',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)

		// JetStream Consumer Backlog Stall Alert.
		//
		// The 2026-07 incident wedged ALL event consumption for ~1 week
		// undetected: a mis-configured durable stopped consumption while the pod
		// stayed Running and emitted no ERROR/poison, so neither the Consumer
		// ERROR Log nor the Poison Queue alert could fire. Consumer backlog
		// (num_pending) is the one signal independent of logs, scraped from the
		// prometheus-nats-exporter sidecar via GMP (see the nats prod overlay
		// PodMonitoring `nats-jetstream-backlog`).
		//
		// The condition uses `min_over_time(...[15m]) > 0`: it fires only when a
		// consumer's backlog stayed above zero for a full 15-minute window —
		// i.e. it never drained to zero, so it is stalled. A healthy consumer
		// (even a bursty low-traffic one) drains to zero between events, so its
		// 15-minute minimum is zero and it does not alert. This detects a silent
		// stall regardless of message volume without per-consumer thresholds.
		//
		// Metric name confirmed against the live exporter on prod nats-0: the
		// prometheus-nats-exporter jsz collector emits `consumer_num_pending`,
		// which the `-prefix=nats` arg prefixes to `nats_consumer_num_pending`
		// (no `jetstream_` segment). Per-series labels include `stream_name`,
		// `consumer_name`, and `account`. Threshold/window are tunable after
		// baseline observation.
		this.consumerBacklogAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-consumer-backlog-stall',
			{
				displayName: 'Consumer JetStream Backlog Stall',
				project: projectId,
				combiner: 'OR',
				conditions: [
					{
						displayName:
							'JetStream consumer backlog not draining for 15m',
						conditionPrometheusQueryLanguage: {
							query: 'min_over_time(nats_consumer_num_pending[15m]) > 0',
							duration: '300s', // sustain 5m beyond the 15m window
							evaluationInterval: '60s',
							// Allow the policy to deploy before the metric has been
							// ingested. GMP only registers nats_consumer_num_pending
							// after the exporter is scraped at least once, so without
							// this a `pulumi up` on a fresh cluster (or before first
							// scrape) fails metric-existence validation and aborts.
							disableMetricValidation: true,
						},
					},
				],
				alertStrategy: {
					// No notificationRateLimit: the GCP API rejects it on
					// non-log-based (metric/PromQL) policies ("only log-based
					// alert policies may specify a notification rate limit").
					// The sustained 15m+5m condition already prevents flapping.
					autoClose: '3600s', // 1 hour
				},
				notificationChannels,
				documentation: {
					content: [
						'## Consumer JetStream Backlog Stall Alert',
						'',
						'A backend JetStream consumer stopped draining its backlog: `num_pending` stayed above zero for a full 15-minute window. Events are being published but not consumed.',
						'',
						'This is the safety net for the 2026-07 silent-outage class: it fires on backlog metrics alone, independent of ERROR logs or poison messages.',
						'',
						'### Alert Labels',
						'- `stream_name` / `consumer_name`: the affected JetStream stream and durable',
						'- `account`: the NATS account (usually `$G`)',
						'',
						'### Triage Steps',
						'1. Check the consumer pod: `kubectl -n backend get pods -l app=consumer` — is it Running, CrashLooping, or restarting?',
						'2. Check `/healthz` liveness: a wedged router / unbound durable now reports unhealthy and should have restarted the pod',
						'3. Inspect the durable: port-forward `nats:4222` and run `nats consumer info <STREAM> <CONSUMER>` — check `push_bound=true` and the delivery/deliver-group config for drift',
						'4. If a durable is mis-configured (stale deliver group / policy), the startup reconciliation should recreate it on the next restart; force a restart with `kubectl -n backend delete pod -l app=consumer`',
						'5. Recover lost events by re-publishing from the source (streams retain 7d); `DeliverNew` durables do not replay already-published messages',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)

		// Sales-reminder delivery outcome metric.
		//
		// Preserves the delivery-reliability visibility (no_subscription / failed
		// per phase stage) that was previously carried by the removed
		// `sales_reminder.delivered` product-analytics event. Delivery reach now
		// lives in PostHog on `notification.delivered` (type = "sales_reminder"),
		// while the operational failure breakdown belongs here, not in product
		// analytics.
		//
		// salesReminderDeliveryUseCase.DeliverReminder emits one structured
		// `sales_reminder delivery outcome` log line per terminal outcome (Info
		// for "delivered", Warn for "no_subscription" / "failed") carrying
		// `outcome` and `phase_stage` fields. This metric counts those lines,
		// keyed by both labels so reach and failure rates stay queryable per
		// stage in Cloud Monitoring. The delivery runs in the backend messaging
		// consumer, so the filter is scoped to the `backend` namespace.
		this.salesReminderDeliveryMetric = new gcp.logging.Metric(
			'log-metric-sales-reminder-delivery-outcomes',
			{
				project: projectId,
				name: 'sales_reminder_delivery_outcomes',
				description:
					'Sales-phase push-reminder delivery outcomes (delivered / no_subscription / failed) per reminder stage. Replaces the operational visibility of the removed sales_reminder.delivered analytics event.',
				filter: pulumi.interpolate`resource.type="k8s_container"
resource.labels.project_id="${projectId}"
resource.labels.location="${clusterLocation}"
resource.labels.cluster_name="${clusterName}"
resource.labels.namespace_name="backend"
jsonPayload.msg="sales_reminder delivery outcome"`,
				metricDescriptor: {
					metricKind: 'DELTA',
					valueType: 'INT64',
					unit: '1',
					labels: [
						{
							key: 'outcome',
							valueType: 'STRING',
							description: 'delivered | no_subscription | failed',
						},
						{
							key: 'phase_stage',
							valueType: 'STRING',
							description: 'reminder stage, e.g. APPLY_OPEN',
						},
					],
				},
				labelExtractors: {
					outcome: 'EXTRACT(jsonPayload.outcome)',
					phase_stage: 'EXTRACT(jsonPayload.phase_stage)',
				},
			},
			{ parent: this },
		)

		// Web Push delivery-failure metric.
		//
		// New-concert push notifications silently stopped reaching every follower
		// for ~2 weeks (2026-07-29 → 2026-08-13) because delivery failures were
		// recorded only in the database — never as a log, metric, or alert. The
		// backend now emits one WARNING `notification delivery failed` log line per
		// failed delivery, carrying a bounded `failure_reason` label (no_subscription
		// / gone / send_error / list_failed / marshal_failed / cancelled). This
		// log-based metric counts those lines, keyed by failure_reason.
		//
		// Deliberately log-based, not a raw OTEL counter: the OTLP collector drops
		// some server metrics for cost, and a not-yet-ingested metric 400s the whole
		// prod `pulumi up`. A log-based metric's descriptor is created with this
		// resource, so it exists immediately (zero data is fine) and the threshold
		// alerts below never hit the missing-metric failure mode. The delivery runs
		// in the backend messaging consumer, so the filter is scoped to `backend`.
		this.webPushDeliveryFailureMetric = new gcp.logging.Metric(
			'log-metric-web-push-delivery-failures',
			{
				project: projectId,
				name: 'web_push_delivery_failures',
				description:
					'Web Push per-notification delivery failures, keyed by bounded failure_reason. Counts the backend WARNING "notification delivery failed" log so a systemic push outage is detectable without querying the notifications table.',
				filter: pulumi.interpolate`resource.type="k8s_container"
resource.labels.project_id="${projectId}"
resource.labels.location="${clusterLocation}"
resource.labels.cluster_name="${clusterName}"
resource.labels.namespace_name="backend"
severity="WARNING"
jsonPayload.msg="notification delivery failed"`,
				metricDescriptor: {
					metricKind: 'DELTA',
					valueType: 'INT64',
					unit: '1',
					labels: [
						{
							key: 'failure_reason',
							valueType: 'STRING',
							description:
								'no_subscription | gone | send_error | list_failed | marshal_failed | cancelled',
						},
					],
				},
				labelExtractors: {
					failure_reason: 'EXTRACT(jsonPayload.failure_reason)',
				},
			},
			{ parent: this },
		)

		// Sustained delivery-failure alert.
		//
		// Fires when delivery failures accumulate over a 10-minute window across all
		// failure reasons. Because the success path is intentionally quiet (it logs
		// nothing), a predominantly-`delivered` window produces no matching logs and
		// the metric stays at zero — so healthy delivery never alerts, while a
		// systemic inability to deliver climbs the counter fast. The threshold
		// doubles as the minimum-volume guard: it takes a sustained batch of
		// failures (not one stray `gone`) to trip, avoiding noise at low pre-launch
		// volume. Threshold/window are tunable operationally; start conservative.
		this.webPushDeliveryFailureAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-web-push-delivery-failure',
			{
				displayName: 'Web Push Delivery Failure Rate',
				project: projectId,
				combiner: 'OR',
				conditions: [
					{
						displayName:
							'Push delivery failures >= 10 per 10m window',
						conditionThreshold: {
							filter: pulumi.interpolate`metric.type="logging.googleapis.com/user/${this.webPushDeliveryFailureMetric.name}" AND resource.type="k8s_container"`,
							aggregations: [
								{
									alignmentPeriod: '600s', // 10 min
									perSeriesAligner: 'ALIGN_DELTA',
									crossSeriesReducer: 'REDUCE_SUM',
								},
							],
							comparison: 'COMPARISON_GT',
							thresholdValue: 10,
							duration: '0s',
							trigger: { count: 1 },
						},
					},
				],
				alertStrategy: {
					// The GCP API rejects `notificationRateLimit` on
					// `conditionThreshold` policies even when the metric is
					// log-derived; the 10m alignment window is the debounce.
					autoClose: '3600s', // 1 hour
				},
				notificationChannels,
				documentation: {
					content: [
						'## Web Push Delivery Failure Rate Alert',
						'',
						'Web Push notification deliveries are failing at a sustained rate (>= 10 failures in a 10-minute window). Notifications are being generated but not reaching users.',
						'',
						'This is the safety net for the 2026-07/08 silent push-outage class: delivery failures used to live only in the DB and went unnoticed for ~2 weeks.',
						'',
						'### Alert Labels',
						'- `failure_reason`: dominant failure category (no_subscription / gone / send_error / list_failed / marshal_failed / cancelled)',
						'',
						'### Triage Steps',
						'1. Break down by reason: `gcloud logging read \'resource.type="k8s_container" AND resource.labels.namespace_name="backend" AND severity="WARNING" AND jsonPayload.msg="notification delivery failed"\' --limit=50` and inspect `failure_reason` / `failure_detail`.',
						'2. If dominated by `no_subscription`, the `Web Push Subscription Starvation` alert should also fire — clients have lost their subscriptions (see that alert).',
						'3. If `send_error`, the web-push send path or VAPID config may be broken — check the backend `server`/`consumer` ERROR logs for the underlying send error.',
						'4. If `gone`, endpoints are being reaped normally; a spike may indicate a mass client churn event.',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)
		this.alertPolicies.push(this.webPushDeliveryFailureAlertPolicy)

		// Active-subscription starvation alert.
		//
		// A complementary signal to the ratio alert: it fires specifically when
		// failures are dominated by `no_subscription` — i.e. notifications are being
		// generated but essentially no active push subscriptions exist to receive
		// them. This is the exact shape of the original outage (every send
		// "completed" as a recorded failure with no endpoint), which a pure
		// send-error alert would miss. Scoped to the `no_subscription` reason label
		// with a lower threshold so a mass subscription loss is caught even at low
		// absolute counts.
		this.webPushSubscriptionStarvationAlertPolicy =
			new gcp.monitoring.AlertPolicy(
				'alert-web-push-subscription-starvation',
				{
					displayName: 'Web Push Subscription Starvation',
					project: projectId,
					combiner: 'OR',
					conditions: [
						{
							displayName:
								'no_subscription failures >= 5 per 10m window',
							conditionThreshold: {
								filter: pulumi.interpolate`metric.type="logging.googleapis.com/user/${this.webPushDeliveryFailureMetric.name}" AND resource.type="k8s_container" AND metric.labels.failure_reason="no_subscription"`,
								aggregations: [
									{
										alignmentPeriod: '600s', // 10 min
										perSeriesAligner: 'ALIGN_DELTA',
										crossSeriesReducer: 'REDUCE_SUM',
									},
								],
								comparison: 'COMPARISON_GT',
								thresholdValue: 5,
								duration: '0s',
								trigger: { count: 1 },
							},
						},
					],
					alertStrategy: {
						autoClose: '3600s', // 1 hour
					},
					notificationChannels,
					documentation: {
						content: [
							'## Web Push Subscription Starvation Alert',
							'',
							'Notifications are being generated but deliveries are failing because the targeted recipients have no active push subscription (`failure_reason="no_subscription"`). This indicates a mass subscription loss — the exact shape of the 2026-08 outage where every send "completed" as a recorded failure with no endpoint to deliver to.',
							'',
							'### Triage Steps',
							'1. Confirm the client recovery paths shipped: the Service Worker `pushsubscriptionchange` handler and the main-thread auto re-subscribe should re-register lapsed clients on next app open.',
							'2. Check whether `push_subscriptions` row count has collapsed (Cloud SQL) — a sudden drop points to a client-side regression (a bad frontend release, VAPID key mismatch, or SW update failure).',
							'3. Verify the VAPID public key served at `/config.json` matches the backend `VAPID_PRIVATE_KEY` keypair; a mismatch prevents every re-subscribe.',
							'4. As clients re-subscribe, the count should recover and this alert auto-closes.',
						].join('\n'),
						mimeType: 'text/markdown',
					},
				},
				{ parent: this },
			)
		this.alertPolicies.push(this.webPushSubscriptionStarvationAlertPolicy)

		this.registerOutputs({
			alertPolicyCount: this.alertPolicies.length,
		})
	}
}
