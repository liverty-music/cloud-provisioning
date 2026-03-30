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
	public readonly googleChatChannels: gcp.monitoring.NotificationChannel[]

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

		this.registerOutputs({
			alertPolicyCount: this.alertPolicies.length,
		})
	}
}
