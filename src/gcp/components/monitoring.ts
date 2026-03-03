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
 */
export class MonitoringComponent extends pulumi.ComponentResource {
	public readonly alertPolicies: gcp.monitoring.AlertPolicy[]

	constructor(
		name: string,
		args: MonitoringComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:MonitoringComponent', name, args, opts)

		const {
			project,
			slackNotificationChannelIds,
			clusterLocation,
			clusterName,
		} = args

		const projectId = project.projectId
		const notificationChannels = slackNotificationChannelIds.map(
			(id) =>
				pulumi.interpolate`projects/${projectId}/notificationChannels/${id}`,
		)

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

		this.registerOutputs({
			alertPolicyCount: this.alertPolicies.length,
		})
	}
}
