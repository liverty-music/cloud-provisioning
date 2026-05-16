import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'

export interface ZitadelMonitoringComponentArgs {
	project: gcp.organizations.Project
	/**
	 * Slack notification channel IDs (created via GCP Console because the API
	 * requires a Slack OAuth flow that is not IaC-friendly). Reused from the
	 * existing `MonitoringComponent` pattern so Zitadel alerts route to the
	 * same on-call surface as backend errors.
	 */
	slackNotificationChannelIds: string[]
	/**
	 * Google Chat NotificationChannel resources passed in from the sibling
	 * `MonitoringComponent`, so Zitadel alerts share the same channel rather
	 * than duplicating it. The `gcp.monitoring.NotificationChannel` API
	 * accepts only a space ID and would otherwise create a second channel
	 * pointing at the same Chat space.
	 */
	googleChatChannels?: gcp.monitoring.NotificationChannel[]
}

/**
 * `ZitadelMonitoringComponent` provisions the alerting / dashboard side of the
 * `zitadel-observability` openspec change:
 *
 *   1. **Zitadel API latency p99** alert on `rpc.server.duration` filtered to
 *      `OIDCService/*` calls — fires when p99 exceeds 10 s for a 60 s window.
 *      The §18.6 cutover-incident hang manifested as 30 s+ responses; this
 *      threshold is 50× the steady-state high-water mark (~200 ms p99).
 *   2. **Backend JWT validation error rate** alert via a Cloud Logging
 *      log-based metric scoped to backend ERROR entries that mention auth
 *      keywords. Surfaces a Zitadel-induced JWKS / token failure cascade
 *      faster than the generic backend ERROR alert.
 *   3. **Cloud SQL connection-pool dashboard panel** — observation-only (no
 *      alert) on `cloudsql.googleapis.com/database/postgresql/num_backends`
 *      for the `zitadel` database. Pairs with the Zitadel-side
 *      `db.pool.{active,idle}_connections` metrics that PR-1a's pipeline
 *      makes available, so an operator can correlate a hang event with both
 *      Cloud SQL- and pool-side connection pressure.
 *
 * Sibling to `MonitoringComponent` (backend error log alerts) and the
 * existing `app-error-log-alerting` capability — same alerting pattern,
 * different subject system.
 *
 * **Runs in all envs** (refactored from dev-only by `refactor-unify-env-dispatch`).
 * The threshold values are deliberately generous (50× over steady-state
 * for latency p99; 10 errors per 60s for JWT validation) — they will not
 * page on pre-launch prod traffic shape. If they become noisy after prod
 * launch traffic ramps up, threshold tuning is a separate operational
 * concern handled in a follow-up change with threshold args added to
 * `ZitadelMonitoringComponentArgs`.
 */
export class ZitadelMonitoringComponent extends pulumi.ComponentResource {
	// Optional because `latencyAlertPolicy` creation is currently disabled
	// (see the `TODO: re-enable...` comment below). When the underlying
	// `workload.googleapis.com/rpc.server.duration` metric becomes
	// available in the prod metric inventory the field returns to required.
	public readonly latencyAlertPolicy?: gcp.monitoring.AlertPolicy
	public readonly jwtErrorMetric: gcp.logging.Metric
	public readonly jwtErrorAlertPolicy: gcp.monitoring.AlertPolicy
	public readonly connectionPoolDashboard: gcp.monitoring.Dashboard

	constructor(
		name: string,
		args: ZitadelMonitoringComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('gcp:liverty-music:ZitadelMonitoringComponent', name, args, opts)

		const { project, slackNotificationChannelIds, googleChatChannels } =
			args

		const projectId = project.projectId

		const slackChannels = slackNotificationChannelIds.map(
			(id) =>
				pulumi.interpolate`projects/${projectId}/notificationChannels/${id}`,
		)

		const notificationChannels = [
			...slackChannels,
			...(googleChatChannels ?? []).map((ch) => ch.name),
		]

		// 1. Zitadel API latency p99 alert
		//
		// Metric: `workload.googleapis.com/rpc.server.duration` is a histogram
		// (DISTRIBUTION, unit ms) emitted by Zitadel's native OTEL SDK and
		// translated by the `googlecloud` exporter. Labels we care about:
		//   - `service_name` — set by `OTEL_RESOURCE_ATTRIBUTES` env var
		//     (configured to `zitadel` in `k8s/namespaces/zitadel/base/configmap.env`)
		//   - `rpc_service` — the gRPC service name like
		//     `zitadel.oidc.v1.OIDCService` or `zitadel.user.v2.UserService`
		//   - `rpc_method` — individual RPC method
		//
		// Filter narrows to OIDCService/* calls because the §18.6 incident
		// shape was specifically `GetAuthRequest` hangs on the OIDC path.
		// Other Zitadel RPCs are watched by the broader `app-error-log-alerting`
		// or by their own future alerts.
		// TODO: re-enable when Zitadel prod emits
		// `workload.googleapis.com/rpc.server.duration`.
		//
		// As of 2026-05-16 the `prod` metric inventory contains
		// `workload.googleapis.com/{db.pool.active_connections,
		// db.pool.idle_connections, http.client.request.body.size,
		// http.client.request.duration}` from Zitadel's OTEL exporter, but
		// NOT `rpc.server.duration`. That metric only appears once Zitadel
		// has handled at least one gRPC server-side RPC AND that span has
		// been flushed through the `googlecloud` exporter (default
		// `OTEL_METRIC_EXPORT_INTERVAL` ~ 60 s) AND GCP has indexed it
		// (~10 min). Without the metric in the inventory the AlertPolicy
		// API rejects the filter with HTTP 404 "Cannot find metric(s)
		// that match type=...", which then aborts every `pulumi up -s prod`
		// for the entire stack.
		//
		// Disabling the alert here unblocks unrelated stack updates (e.g.,
		// `claude-review-check-run` Required Status Check rollout in
		// liverty-music/specification#474). The other Zitadel monitoring
		// resources (JWT error metric/alert, connection-pool dashboard)
		// are unaffected.
		//
		// Re-enablement criteria — verify the metric is present:
		//   curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
		//     "https://monitoring.googleapis.com/v3/projects/liverty-music-prod/metricDescriptors?filter=metric.type=%22workload.googleapis.com/rpc.server.duration%22" \
		//     | jq '.metricDescriptors | length'
		// When this returns > 0, revert this commit (or open a follow-up
		// that re-instantiates the block below verbatim).
		//
		// this.latencyAlertPolicy = new gcp.monitoring.AlertPolicy(
		// 	'alert-zitadel-oidc-latency-p99',
		// 	{
		// 		displayName: 'Zitadel OIDCService p99 latency',
		// 		project: projectId,
		// 		combiner: 'OR',
		// 		conditions: [
		// 			{
		// 				displayName: 'OIDCService p99 > 10s for 60s',
		// 				conditionThreshold: {
		// 					filter:
		// 						'metric.type="workload.googleapis.com/rpc.server.duration" ' +
		// 						'AND resource.type="generic_task" ' +
		// 						'AND metric.labels.service_name="zitadel" ' +
		// 						'AND metric.labels.rpc_service=monitoring.regex.full_match(".*OIDCService.*")',
		// 					aggregations: [
		// 						{
		// 							// `rpc.server.duration` is a CUMULATIVE
		// 							// DISTRIBUTION metric (OTEL histogram, translated
		// 							// by the `googlecloud` exporter). The percentile
		// 							// aligner cannot be applied directly to cumulative
		// 							// distributions (GCP API rejects with "ALIGN_PERCENTILE_99
		// 							// cannot be applied to metrics with kind CUMULATIVE
		// 							// and value type DISTRIBUTION"). Two-stage pattern:
		// 							//   1. `ALIGN_DELTA` over 60 s converts cumulative
		// 							//      → delta DISTRIBUTION (matches OTEL_METRIC_EXPORT_INTERVAL
		// 							//      so each cycle sees ~1 fresh point with a full
		// 							//      60 s of in-process histogram aggregation).
		// 							//   2. `REDUCE_PERCENTILE_99` across series grouped
		// 							//      by `rpc_method` produces one p99 line per
		// 							//      method — fires when ANY method's p99 > 10 s.
		// 							alignmentPeriod: '60s',
		// 							perSeriesAligner: 'ALIGN_DELTA',
		// 							crossSeriesReducer: 'REDUCE_PERCENTILE_99',
		// 							groupByFields: ['metric.labels.rpc_method'],
		// 						},
		// 					],
		// 					comparison: 'COMPARISON_GT',
		// 					// `unit:"ms"` per the OTEL histogram descriptor →
		// 					// 10 s = 10000 ms. Healthy steady state is ~200 ms,
		// 					// so 10 s is 50× the high-water mark (design D3).
		// 					thresholdValue: 10000,
		// 					duration: '60s',
		// 					trigger: { count: 1 },
		// 				},
		// 			},
		// 		],
		// 		alertStrategy: {
		// 			// `notificationRateLimit` is not allowed on metric-threshold
		// 			// alerts (only on log-match alerts) per the GCP Monitoring
		// 			// API. Debouncing is provided by the 60 s alignmentPeriod
		// 			// + 60 s `duration` above — a transient blip cannot fire.
		// 			autoClose: '3600s', // 1 hour
		// 		},
		// 		notificationChannels,
		// 		documentation: {
		// 			content: [
		// 				'## Zitadel OIDCService p99 Latency Alert',
		// 				'',
		// 				'Zitadel API `OIDCService/*` p99 latency exceeded 10 seconds for at least 60 seconds.',
		// 				'',
		// 				'**Most likely cause**: the §18.6 cutover-incident hang shape — Zitadel API container hung on `GetAuthRequest` after extended uptime + a high-density burst of state-changing API calls.',
		// 				'',
		// 				'### Triage Steps',
		// 				'',
		// 				'1. Open the runbook: `cloud-provisioning/docs/runbooks/zitadel-hang.md`',
		// 				'2. **Capture forensic data BEFORE mitigation** (logs, connection-pool metrics, in-cluster smoke test) — restart erases in-memory state we need to disambiguate hypothesis A (projection-updater write-lock) vs. hypothesis B (connection-pool exhaustion)',
		// 				'3. Mitigation: `kubectl rollout restart deployment/zitadel-api -n zitadel`',
		// 				'4. Verify recovery: `/debug/healthz` → 200, OIDC discovery sub-second',
		// 				'',
		// 				'### Related signals to check',
		// 				'',
		// 				'- **Cloud SQL connection pool**: see the `Zitadel observability` dashboard for the `zitadel` database `num_backends` panel — saturation precedes the hang in hypothesis B',
		// 				'- **Backend JWT validation errors**: a correlated alert may also fire if Zitadel hangs are causing token validation failures at backend',
		// 			].join('\n'),
		// 			mimeType: 'text/markdown',
		// 		},
		// 	},
		// 	{ parent: this },
		// )

		// 2. Backend JWT validation error rate
		//
		// Cloud Logging log-based metric counts backend ERROR entries with
		// auth-related keywords. Backend's `JWTValidator.ValidateToken`
		// returns wrapped errors that propagate up through the connect-rpc
		// authn middleware; the resulting structured log entries carry
		// `severity=ERROR` and a payload that mentions the failure class.
		//
		// Filter is intentionally broad-then-tight: scoped to the `backend`
		// namespace + `server` workload (the only place that validates
		// Zitadel-issued JWTs), then keyword-filtered. False positives are
		// acceptable in dev — a 10/min threshold is well above steady-state.
		this.jwtErrorMetric = new gcp.logging.Metric(
			'log-metric-backend-jwt-zitadel-errors',
			{
				project: projectId,
				name: 'backend_jwt_validation_zitadel_errors',
				description:
					'Backend ERROR log entries from JWT / JWKS / authn paths. Surfaces Zitadel-induced auth failure cascades faster than the generic backend ERROR alert.',
				filter: [
					'resource.type="k8s_container"',
					'resource.labels.namespace_name="backend"',
					'labels.k8s-pod/app="server"',
					'severity="ERROR"',
					'(jsonPayload.msg=~"(?i)jwt|jwks|token|authn|invalid token|failed to validate" OR jsonPayload.error=~"(?i)jwks|jwt|zitadel")',
				].join(' AND '),
				metricDescriptor: {
					metricKind: 'DELTA',
					valueType: 'INT64',
					unit: '1',
				},
			},
			{ parent: this },
		)

		this.jwtErrorAlertPolicy = new gcp.monitoring.AlertPolicy(
			'alert-backend-jwt-zitadel-errors',
			{
				displayName: 'Backend JWT validation error rate',
				project: projectId,
				combiner: 'OR',
				conditions: [
					{
						displayName: 'JWT/JWKS/authn ERRORs > 10/min for 5 min',
						conditionThreshold: {
							filter: pulumi.interpolate`metric.type="logging.googleapis.com/user/${this.jwtErrorMetric.name}" AND resource.type="k8s_container"`,
							aggregations: [
								{
									alignmentPeriod: '60s',
									perSeriesAligner: 'ALIGN_RATE',
									crossSeriesReducer: 'REDUCE_SUM',
								},
							],
							comparison: 'COMPARISON_GT',
							// 10 events / minute = 0.167 events / second
							// (ALIGN_RATE returns events / second).
							thresholdValue: 10 / 60,
							duration: '300s', // 5 min sustained
							trigger: { count: 1 },
						},
					},
				],
				alertStrategy: {
					// Same rule as the latency alert above — the GCP API
					// rejects `notificationRateLimit` on `conditionThreshold`
					// alerts, even when the metric is log-derived. Debouncing
					// here is the 60 s alignment + 300 s `duration`.
					autoClose: '3600s',
				},
				notificationChannels,
				documentation: {
					content: [
						'## Backend JWT Validation Error Rate Alert',
						'',
						'Backend JWT / JWKS / authn ERROR log rate exceeded 10 events/minute for 5 minutes — typical of a Zitadel-induced auth failure cascade.',
						'',
						'### Triage Steps',
						'',
						'1. Confirm the source — `gcloud logging read \'resource.type="k8s_container" AND resource.labels.namespace_name="backend" AND labels.k8s-pod/app="server" AND severity="ERROR" AND timestamp >= "<now-15min>"\' --limit=50` to inspect the actual error payload.',
						'2. Common causes:',
						'   - **Zitadel API hang** (§18.6 shape): the OIDCService latency alert should also fire. See `cloud-provisioning/docs/runbooks/zitadel-hang.md`.',
						'   - **JWKS unreachable**: Zitadel API behind the cluster Gateway is failing health checks. `kubectl get pods -n zitadel`.',
						'   - **Zitadel re-deploy**: a brief window during pod rollout where the JWKS cache fetches a fresh keyset can trigger a transient burst — usually self-resolves within 60 s.',
						'3. Verify the `Zitadel OIDCService p99 latency` alert is also firing if the cause is upstream (Zitadel) rather than downstream (backend).',
					].join('\n'),
					mimeType: 'text/markdown',
				},
			},
			{ parent: this },
		)

		// 3. Cloud SQL connection-pool dashboard panel
		//
		// `num_backends` is the count of currently-active Postgres backends
		// against the Cloud SQL instance, exported by Cloud SQL itself
		// (no OTEL pipeline involved). Plus the Zitadel-side
		// `db.pool.{active,idle}_connections` from the OTEL SDK on the pgx
		// pool — those provide the inverse view (Zitadel's perspective on
		// its own pool) and complement the `num_backends` figure.
		//
		// Observation-only; the threshold for an *alert* depends on data we
		// do not yet have (steady-state high-water mark + how close to
		// saturation §18.6 hypothesis B's pre-hang state actually was). Once
		// the next hang reproduces and we can correlate, a follow-up change
		// adds the alert with a derived threshold.
		//
		// The Cloud SQL panel does carry a *visual* threshold line at 20
		// (= 80% of `max_connections=25`, the GCP default for the
		// `db-f1-micro` tier `postgres-osaka` runs on — see
		// `postgres.ts:107`). If that tier ever changes, the panel value
		// must be re-derived because the GCP default scales with tier
		// memory. The line is observational guidance, not an alert
		// threshold.
		this.connectionPoolDashboard = new gcp.monitoring.Dashboard(
			'dashboard-zitadel-observability',
			{
				project: projectId,
				dashboardJson: pulumi.interpolate`{
  "displayName": "Zitadel Observability",
  "mosaicLayout": {
    "columns": 12,
    "tiles": [
      {
        "xPos": 0,
        "yPos": 0,
        "width": 12,
        "height": 4,
        "widget": {
          "title": "Cloud SQL — zitadel database — backend connection count (num_backends)",
          "xyChart": {
            "dataSets": [
              {
                "timeSeriesQuery": {
                  "timeSeriesFilter": {
                    "filter": "metric.type=\\"cloudsql.googleapis.com/database/postgresql/num_backends\\" AND resource.labels.database_id=\\"${projectId}:postgres-osaka\\" AND metric.labels.database=\\"zitadel\\"",
                    "aggregation": {
                      "alignmentPeriod": "60s",
                      "perSeriesAligner": "ALIGN_MEAN",
                      "crossSeriesReducer": "REDUCE_SUM"
                    }
                  },
                  "unitOverride": "1"
                },
                "plotType": "LINE",
                "targetAxis": "Y1",
                "legendTemplate": "num_backends"
              }
            ],
            "thresholds": [
              { "value": 20, "label": "80% of max_connections (dev tier db-f1-micro → 25)" }
            ],
            "yAxis": {
              "label": "active backends",
              "scale": "LINEAR"
            }
          }
        }
      },
      {
        "xPos": 0,
        "yPos": 4,
        "width": 6,
        "height": 4,
        "widget": {
          "title": "Zitadel — pgx pool active connections (Zitadel side)",
          "xyChart": {
            "dataSets": [
              {
                "timeSeriesQuery": {
                  "timeSeriesFilter": {
                    "filter": "metric.type=\\"workload.googleapis.com/db.pool.active_connections\\" AND metric.labels.service_name=\\"zitadel\\"",
                    "aggregation": {
                      "alignmentPeriod": "60s",
                      "perSeriesAligner": "ALIGN_MEAN",
                      "crossSeriesReducer": "REDUCE_SUM"
                    }
                  },
                  "unitOverride": "1"
                },
                "plotType": "LINE",
                "targetAxis": "Y1",
                "legendTemplate": "active"
              },
              {
                "timeSeriesQuery": {
                  "timeSeriesFilter": {
                    "filter": "metric.type=\\"workload.googleapis.com/db.pool.idle_connections\\" AND metric.labels.service_name=\\"zitadel\\"",
                    "aggregation": {
                      "alignmentPeriod": "60s",
                      "perSeriesAligner": "ALIGN_MEAN",
                      "crossSeriesReducer": "REDUCE_SUM"
                    }
                  },
                  "unitOverride": "1"
                },
                "plotType": "LINE",
                "targetAxis": "Y1",
                "legendTemplate": "idle"
              }
            ],
            "yAxis": { "label": "connections", "scale": "LINEAR" }
          }
        }
      },
      {
        "xPos": 6,
        "yPos": 4,
        "width": 6,
        "height": 4,
        "widget": {
          "title": "Zitadel — OIDCService p99 latency (alerting metric)",
          "xyChart": {
            "dataSets": [
              {
                "timeSeriesQuery": {
                  "timeSeriesFilter": {
                    "filter": "metric.type=\\"workload.googleapis.com/rpc.server.duration\\" AND metric.labels.service_name=\\"zitadel\\" AND metric.labels.rpc_service=monitoring.regex.full_match(\\".*OIDCService.*\\")",
                    "aggregation": {
                      "alignmentPeriod": "60s",
                      "perSeriesAligner": "ALIGN_DELTA",
                      "crossSeriesReducer": "REDUCE_PERCENTILE_99",
                      "groupByFields": ["metric.labels.rpc_method"]
                    }
                  },
                  "unitOverride": "ms"
                },
                "plotType": "LINE",
                "targetAxis": "Y1",
                "legendTemplate": "p99 \${metric.labels.rpc_method}"
              }
            ],
            "thresholds": [
              { "value": 10000, "label": "alert threshold (10 s)" }
            ],
            "yAxis": { "label": "ms", "scale": "LOG10" }
          }
        }
      }
    ]
  }
}`,
			},
			{ parent: this },
		)

		this.registerOutputs({
			latencyAlertPolicyName: this.latencyAlertPolicy?.name,
			jwtErrorAlertPolicyName: this.jwtErrorAlertPolicy.name,
			dashboardName: this.connectionPoolDashboard.id,
		})
	}
}
