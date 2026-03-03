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
	environment: string
	/** GKE cluster location (e.g., "asia-northeast2"). */
	clusterLocation: string
	/** GKE cluster name (e.g., "cluster-osaka"). */
	clusterName: string
	/** Google Chat Space ID for alert notifications (e.g., "spaces/XXXXXXXXX"). */
	chatSpaceId: string
	/** Email address for alert notifications. */
	notificationEmail: string
}

/**
 * MonitoringComponent provisions Cloud Monitoring notification channels
 * and log-based alert policies for backend workload ERROR log detection.
 */
export class MonitoringComponent extends pulumi.ComponentResource {
	public readonly chatChannel: gcp.monitoring.NotificationChannel
	public readonly emailChannel: gcp.monitoring.NotificationChannel
	public readonly alertPolicies: gcp.monitoring.AlertPolicy[]

	constructor(
		name: string,
		args: MonitoringComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:MonitoringComponent', name, args, opts)

		const {
			project,
			clusterLocation,
			clusterName,
			chatSpaceId,
			notificationEmail,
		} = args

		// 1. Notification Channels
		this.chatChannel = new gcp.monitoring.NotificationChannel(
			'notification-google-chat',
			{
				displayName: `Google Chat`,
				type: 'google_chat',
				project: project.projectId,
				labels: {
					space_id: chatSpaceId,
				},
			},
			{ parent: this },
		)

		this.emailChannel = new gcp.monitoring.NotificationChannel(
			'notification-email',
			{
				displayName: `Email`,
				type: 'email',
				project: project.projectId,
				labels: {
					email_address: notificationEmail,
				},
			},
			{ parent: this },
		)

		const notificationChannels = [
			this.chatChannel.name,
			this.emailChannel.name,
		]

		// 2. Log-Based Alert Policies (one per workload)
		const projectId = project.projectId
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

		this.registerOutputs({
			chatChannelName: this.chatChannel.name,
			emailChannelName: this.emailChannel.name,
			alertPolicyCount: this.alertPolicies.length,
		})
	}
}
