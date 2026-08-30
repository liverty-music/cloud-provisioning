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
	public readonly goroutineLeakAlertPolicy: gcp.monitoring.AlertPolicy
	public readonly clusterSecretStoreNotReadyAlertPolicy: gcp.monitoring.AlertPolicy
	public readonly externalSecretNotReadyAlertPolicy: gcp.monitoring.AlertPolicy
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
		// appLabel MUST match each workload's live `app` pod label. Renamed by
		// unify-workload-naming: server->fan-api, consumer->event-consumer (the
		// cronjob labels are unchanged). A stale appLabel silently orphans the
		// per-workload ERROR-log alert (the log filter matches no pod).
		const workloads: Workload[] = [
			{ displayName: 'Fan API', appLabel: 'fan-api' },
			{ displayName: 'Event Consumer', appLabel: 'event-consumer' },
			{
				displayName: 'Concert Discovery',
				appLabel: 'concert-discovery',
			},
			{
				displayName: 'Sales Phase Discovery',
				appLabel: 'sales-phase-discovery',
			},
			// media-processor logs ERROR only for genuine system failures (GCS/DB
			// write, libvips-internal); invalid/unsafe uploads are user error and
			// log WARN, so this alert stays incident-only. Queue backlog for its
			// `media_uploaded` durable is already covered by the unfiltered
			// Consumer JetStream Backlog Stall policy below.
			{
				displayName: 'Media Processor',
				appLabel: 'media-processor',
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
		// This is a secondary safety net: the event-consumer workload alert above
		// also fires on any event-consumer ERROR, but this policy is scoped to
		// poison queue events specifically to aid triage.
		const poisonQueueAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-poison-queue-message',
			{
				displayName: 'Event Consumer Poison Queue Message',
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
labels.k8s-pod/app="event-consumer"
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
						'1. Check the event-consumer pod: `kubectl -n backend get pods -l app=event-consumer` — is it Running, CrashLooping, or restarting?',
						'2. Check `/healthz` liveness: a wedged router / unbound durable now reports unhealthy and should have restarted the pod',
						'3. Inspect the durable: port-forward `nats:4222` and run `nats consumer info <STREAM> <CONSUMER>` — check `push_bound=true` and the delivery/deliver-group config for drift',
						'4. If a durable is mis-configured (stale deliver group / policy), the startup reconciliation should recreate it on the next restart; force a restart with `kubectl -n backend delete pod -l app=event-consumer`',
						'5. Recover lost events by re-publishing from the source (streams retain 7d); `DeliverNew` durables do not replay already-published messages',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)

		// Goroutine Leak Alert.
		//
		// Go 1.27 promoted the runtime `goroutineleak` profile to GA: it reports
		// goroutines permanently blocked on a concurrency primitive (channel op,
		// sync.Mutex, sync.Cond) with no possibility of becoming runnable. The
		// backend samples it on a coarse interval and publishes the leaked count
		// as the OTel gauge `backend_goroutine_leak_count`, tagged with a
		// `workload` label. This is the additive safety net for the silent-wedge
		// class (e.g. the 2026-07 consumer outage) that backlog-stall and
		// liveness signals can miss — it fires on the Go-side-blocked subset that
		// those signals don't cover, and does NOT replace them.
		//
		// Pipeline note: the backend pushes OTLP metrics to the in-cluster
		// otel-collector, which exports via the `googlecloud` exporter — so this
		// gauge lands in Cloud Monitoring as
		// `workload.googleapis.com/backend_goroutine_leak_count` (a standard
		// custom metric), NOT in Google Managed Prometheus. It therefore uses a
		// `conditionThreshold` (like the Zitadel db.pool and web-push metric
		// alerts) rather than the PromQL condition the consumer-backlog alert
		// uses for its GMP-scraped `nats_consumer_num_pending`. The collector's
		// drop-filter only excludes `rpc.server.*` / `http.client.*`, so this
		// metric passes through with no collector change.
		//
		// Transient vs sustained: `ALIGN_MIN` over a 10-minute window means the
		// leaked count must have stayed above zero for the ENTIRE window (it
		// never cleared) before firing — a momentary blip that clears drops a
		// sample to zero and resets. `REDUCE_MAX` grouped by `workload` keeps
		// each workload its own series (so any leaking pod trips it and the
		// alert names the affected workload), and `autoClose` resolves the
		// incident once the count returns to zero for the recovery window.
		this.goroutineLeakAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-goroutine-leak',
			{
				displayName: 'Backend Goroutine Leak',
				project: projectId,
				combiner: 'OR',
				conditions: [
					{
						displayName:
							'Leaked goroutines sustained above zero for 10m',
						conditionThreshold: {
							// GCP requires a `resource.type` restriction on threshold
							// filters. The otel-collector `googlecloud` exporter lands
							// this OTLP gauge on the `generic_node` monitored resource
							// (confirmed against the live prod time series), so pin it —
							// omitting it fails at apply time with HTTP 400 even though
							// `pulumi preview` passes.
							filter: 'metric.type="workload.googleapis.com/backend_goroutine_leak_count" AND resource.type="generic_node"',
							aggregations: [
								{
									alignmentPeriod: '600s', // 10-minute sustain window
									perSeriesAligner: 'ALIGN_MIN',
									crossSeriesReducer: 'REDUCE_MAX',
									groupByFields: ['metric.label.workload'],
								},
							],
							comparison: 'COMPARISON_GT',
							thresholdValue: 0,
							// The 10m ALIGN_MIN window already encodes the
							// sustain, so no extra duration is needed.
							duration: '0s',
							trigger: { count: 1 },
						},
					},
				],
				alertStrategy: {
					// notificationRateLimit is rejected by the GCP API on
					// threshold (non-log-based) policies; the 10m ALIGN_MIN
					// window is the debounce.
					autoClose: '3600s', // 1 hour
				},
				notificationChannels,
				documentation: {
					content: [
						'## Backend Goroutine Leak Alert',
						'',
						'A backend workload has one or more goroutines permanently blocked on a concurrency primitive (channel operation, `sync.Mutex`, or `sync.Cond`) with no possibility of becoming runnable — the Go 1.27 `goroutineleak` profile has reported a non-zero count sustained for a full 10-minute window.',
						'',
						'This is the additive safety net for the silent-wedge class (e.g. the 2026-07 consumer outage): it catches the Go-side-blocked subset that the `Consumer JetStream Backlog Stall` and liveness signals can miss. It does NOT replace them.',
						'',
						'### Alert Labels',
						'- `workload`: the affected workload, from the OTel gauge attribute (= the pod’s `TELEMETRY_SERVICE_NAME`): `liverty-music-backend` (the fan-api / admin binary) or `liverty-music-consumer` (the event-consumer). Note this is NOT the pod `app` label — see the mapping in triage step 1.',
						'',
						'### Known Blind Spots',
						'- Leaks reachable only via **global variables** are not reported.',
						'- Goroutines that remain **runnable** (spinning, not blocked on a primitive) are not reported.',
						'- NATS-internal wedges that do not block a Go goroutine on a primitive are not reported — the `Consumer JetStream Backlog Stall` alert remains the complementary signal for those.',
						'',
						'### Triage Steps',
						'1. Map the `workload` label to the pod `app` label — `liverty-music-backend` → `app=fan-api`, `liverty-music-consumer` → `app=event-consumer` — then find the pod: `kubectl -n backend get pods -l app=<app-label>`.',
						'2. Pull a full profile with stacks from the internal pprof listener (never exposed publicly): `kubectl -n backend port-forward <pod> 6060:6060` then open `http://localhost:6060/debug/pprof/goroutineleak?debug=2` to see each leaked goroutine and its blocking stack.',
						'3. Identify the blocking site from the stack (channel receive/send, mutex, cond) and correlate with recent deploys or a stalled dependency.',
						'4. Restart the wedged pod to recover service while the root cause is fixed: `kubectl -n backend delete pod <pod>`.',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)
		this.alertPolicies.push(this.goroutineLeakAlertPolicy)

		// ClusterSecretStore not-ready alert (CP#457 detection hardening).
		//
		// The 2026-08-24 incident left `ClusterSecretStore google-secret-manager`
		// Ready=False for ~38h, silently stopping ALL secret sync cluster-wide
		// (8/9 ExternalSecrets stale). The ESO controller was rescheduled onto a
		// fresh node, could not acquire its Workload Identity credential at
		// startup, and does not self-heal from that state — yet nothing paged.
		//
		// The External Secrets Operator publishes per-store status-condition
		// gauges. Confirmed against ESO v0.12.1 source (cssmetrics.go): the metric
		// is `clustersecretstore_status_condition` with labels `condition` and
		// `status`, and the CURRENT `{condition,status}` series is set to 1. So a
		// not-ready store is exactly
		// `clustersecretstore_status_condition{condition="Ready",status="False"} == 1`.
		// The ESO controller pod is scraped into GMP by the `external-secrets-status`
		// PodMonitoring (external-secrets prod overlay), the same GMP → PromQL
		// path as the nats consumer-backlog alert above.
		//
		// A 10-minute sustain (`duration`) debounces the brief not-ready blips a
		// normal controller restart / reconcile produces, while still firing
		// ~228x sooner than the 38h silent window. This is the top-priority
		// signal: a not-ready ClusterSecretStore halts secret sync cluster-wide.
		this.clusterSecretStoreNotReadyAlertPolicy =
			new gcp.monitoring.AlertPolicy(
				'alert-clustersecretstore-not-ready',
				{
					displayName: 'ClusterSecretStore Not Ready',
					project: projectId,
					combiner: 'OR',
					conditions: [
						{
							displayName:
								'ClusterSecretStore Ready=False sustained for 10m',
							conditionPrometheusQueryLanguage: {
								query: 'clustersecretstore_status_condition{condition="Ready",status="False"} == 1',
								duration: '600s', // sustain 10m to debounce restart/reconcile blips
								evaluationInterval: '60s',
								// GMP only registers the metric after the ESO
								// controller is scraped at least once; without this
								// a fresh-cluster `pulumi up` (or pre-first-scrape)
								// fails metric-existence validation and aborts.
								disableMetricValidation: true,
							},
						},
					],
					alertStrategy: {
						// notificationRateLimit is rejected by the GCP API on
						// PromQL (non-log-based) policies; the 10m sustain debounces.
						autoClose: '3600s', // 1 hour
					},
					notificationChannels,
					documentation: {
						content: [
							'## ClusterSecretStore Not Ready Alert',
							'',
							'An ESO `ClusterSecretStore` has been `Ready=False` for a sustained 10-minute window. While a store is not ready, every `ExternalSecret` bound to it stops syncing — secret rotation and newly-added keys never propagate cluster-wide.',
							'',
							'This is the safety net for the 2026-08-24 silent-outage class (CP#457): the store was `Ready=False` for ~38h, undetected, because nothing scraped or alerted on ESO health. Running pods kept working on last-synced (stale) values, so there were no crashes — but no rotation landed.',
							'',
							'### Likely Cause',
							'- The ESO controller pod lost its Workload Identity credential (e.g. rescheduled onto a fresh node with a metadata-server startup race). IAM is usually correct — this is a pod/node-scoped auth failure ESO does not self-heal from.',
							'',
							'### Triage Steps',
							'1. Confirm: `kubectl get clustersecretstore google-secret-manager -o jsonpath=\'{.status.conditions[?(@.type=="Ready")].status}\'` → expect `False`, message `could not find default credentials`.',
							'2. Recover: `kubectl rollout restart deployment external-secrets -n external-secrets` — a new pod on a healthy node re-acquires WI and the store returns to `Ready=True`.',
							'3. Verify: `kubectl get externalsecrets -A` (all `Ready=True`).',
							'4. Restart any workload whose secret changed while the store was down — `envFrom` does NOT hot-reload, so the pod keeps the stale value until restarted: `kubectl rollout restart deploy/<name> -n <ns>`.',
						].join('\n'),
						mimeType: 'text/markdown',
					},
				},
				{ parent: this },
			)
		this.alertPolicies.push(this.clusterSecretStoreNotReadyAlertPolicy)

		// ExternalSecret not-ready alert (CP#457 detection hardening).
		//
		// Complementary, finer-grained net to the store alert above: it fires on
		// an individual `ExternalSecret` stuck `Ready=False` even when the store
		// itself is healthy (e.g. a single missing/renamed secret key, a
		// per-secret provider error). Metric confirmed against ESO v0.12.1 source
		// (esmetrics.go): `externalsecret_status_condition` with labels
		// `condition` / `status` (plus `name` / `namespace`), current series = 1.
		//
		// A slightly longer 15-minute sustain absorbs the transient not-ready an
		// ExternalSecret shows mid-resync, so only a genuinely stuck secret pages.
		this.externalSecretNotReadyAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-externalsecret-not-ready',
			{
				displayName: 'ExternalSecret Not Ready',
				project: projectId,
				combiner: 'OR',
				conditions: [
					{
						displayName:
							'ExternalSecret Ready=False sustained for 15m',
						conditionPrometheusQueryLanguage: {
							query: 'externalsecret_status_condition{condition="Ready",status="False"} == 1',
							duration: '900s', // sustain 15m — absorb mid-resync blips
							evaluationInterval: '60s',
							disableMetricValidation: true,
						},
					},
				],
				alertStrategy: {
					autoClose: '3600s', // 1 hour
				},
				notificationChannels,
				documentation: {
					content: [
						'## ExternalSecret Not Ready Alert',
						'',
						'An individual `ExternalSecret` has been `Ready=False` for a sustained 15-minute window — its Kubernetes Secret is no longer being synced from the provider. This fires even when the `ClusterSecretStore` is healthy, catching per-secret failures (a missing/renamed Secret Manager key, a provider-side permission error) that the store-level alert would miss.',
						'',
						'### Triage Steps',
						'1. Find the affected secret: `kubectl get externalsecrets -A` and look for `STATUS` != `SecretSynced`.',
						'2. Inspect it: `kubectl describe externalsecret <name> -n <ns>` — the condition message names the failure (e.g. `could not get secret data from provider`).',
						'3. If MANY ExternalSecrets are not ready at once, this is a store-wide outage — see the `ClusterSecretStore Not Ready` alert and its runbook (`rollout restart deployment external-secrets`).',
						'4. If only ONE is failing, the cause is usually that specific secret: confirm the referenced Secret Manager key exists and the ESO GSA has `roles/secretmanager.secretAccessor` on it.',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)
		this.alertPolicies.push(this.externalSecretNotReadyAlertPolicy)

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
