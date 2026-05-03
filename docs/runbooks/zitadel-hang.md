# Runbook: Zitadel API hang on `GetAuthRequest`

> **Source of truth:** this runbook is derived from
> `specification/openspec/specs/zitadel-observability/spec.md` →
> "Operator runbook for the Zitadel hang incident shape" requirement.
> If the spec is updated, regenerate this file in the same PR.

## When this runbook applies

You received the **Zitadel API latency p99** alert — `OIDCService/*`
p99 above 10 seconds — and observe one or more of:

- `GetAuthRequest` (or another `OIDCService/*` call) is timing out
  at 30+ seconds.
- Zitadel API responses include `code: internal` with no useful
  message body.
- `https://auth.dev.liverty-music.app/.well-known/openid-configuration`
  takes seconds-to-tens-of-seconds to return (or doesn't return).
- Backend JWT validation is failing in a correlated burst (the
  **backend JWT validation error rate** alert may also be firing).
- The Zitadel API pod's age is ≥ ~3 days (the hang precondition
  empirically requires accumulated in-memory state, not just any
  short-uptime hiccup).

If only one of these symptoms is present without the others, it's
probably **not** the §18.6 hang shape — investigate as a fresh
incident before reaching for the mitigation below.

The §18.6 cutover-incident chain that this runbook captures was:
~30 minutes of high-density state-changing API operations
(multiple `_activate`, MachineKey replace, Action delete, email
change) against a 3.5-day-old Zitadel API pod. Two hypotheses are
documented for the root cause; both are resolved by a pod restart:

1. **Hypothesis A:** in-memory projection updater stuck on a write
   lock during the burst.
2. **Hypothesis B:** Cloud SQL connection-pool exhaustion from
   leaked connections in async notification-worker retries.

Capture forensic data **before** restarting — once the pod is
recycled, all in-memory state is gone and we lose the only chance
to disambiguate the two hypotheses.

## Forensic data capture (BEFORE mitigation)

Save everything to `/tmp/zitadel-hang-$(date -u +%Y%m%dT%H%M%SZ)/` so
the captured artifacts survive your terminal session ending. The
directory should be uploaded to the §18.6 follow-up issue once the
incident is resolved.

```bash
INCIDENT_DIR="/tmp/zitadel-hang-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$INCIDENT_DIR"
cd "$INCIDENT_DIR"

# Cross-platform "1 hour ago" — GNU `date -d` on Linux, BSD `date -v`
# on macOS. We try GNU first; if that errors (BSD does not understand
# `-d`), the `||` falls through to the BSD form. Used by the gcloud
# calls below.
ONE_HOUR_AGO=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)

# 1. Identify the affected pod.
kubectl get pods -n zitadel -l component=api -o wide > pods.txt

ZITADEL_POD=$(kubectl get pods -n zitadel -l component=api -o jsonpath='{.items[0].metadata.name}')
echo "Affected pod: $ZITADEL_POD" | tee -a NOTES.md

# 2. Pod state — uptime, restarts, recent events.
kubectl describe pod -n zitadel "$ZITADEL_POD" > pod-describe.txt
kubectl get events -n zitadel --sort-by=.lastTimestamp > events.txt

# 3. Recent application logs (last 30 minutes).
kubectl logs -n zitadel "$ZITADEL_POD" -c zitadel --since=30m > zitadel-logs.txt

# 4. Cloud SQL Auth Proxy sidecar logs — if hypothesis B is right,
#    the proxy will show connection saturation here.
kubectl logs -n zitadel "$ZITADEL_POD" -c cloud-sql-proxy --since=30m > sql-proxy-logs.txt

# 5. Cloud SQL connection-pool metric snapshot. The
#    `zitadel-observability` dashboard panel shows the same data
#    visually; this saves the underlying values for the issue tracker.
gcloud monitoring time-series list \
  --project=liverty-music-dev \
  --filter='metric.type="cloudsql.googleapis.com/database/postgresql/num_backends" AND resource.label.database_id="liverty-music-dev:postgres-osaka"' \
  --interval-end-time=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --interval-start-time="$ONE_HOUR_AGO" \
  --format=json > sql-num-backends.json

# 6. Recent Zitadel API request rate by gRPC method, to identify
#    whether a state-changing API burst preceded the hang.
gcloud logging read \
  'resource.type="k8s_container" AND resource.labels.namespace_name="zitadel" AND resource.labels.container_name="zitadel" AND timestamp>="'"$ONE_HOUR_AGO"'"' \
  --project=liverty-music-dev \
  --limit=10000 \
  --format=json > zitadel-recent-api-calls.json

# 7. Live API smoke test from inside the cluster, to confirm the
#    hang is reproducible at the moment of mitigation.
kubectl run -n zitadel zitadel-smoke-$$ \
  --rm -i --restart=Never \
  --image=curlimages/curl:8.10.1 \
  --command -- curl -sS -m 35 -o /dev/null -w 'http_code=%{http_code} time=%{time_total}\n' \
  http://zitadel.zitadel.svc.cluster.local:8080/.well-known/openid-configuration \
  > smoke-test.txt 2>&1

ls -la "$INCIDENT_DIR"
```

## Mitigation

After the forensic capture above completes, restart the Deployment.

```bash
# Confirm you're targeting the right cluster!
kubectl config current-context
# expected: gke_liverty-music-dev_asia-northeast2-a_standard-cluster-osaka

kubectl rollout restart deployment/zitadel -n zitadel
kubectl rollout status deployment/zitadel -n zitadel --timeout=120s
```

The default RollingUpdate strategy (`maxUnavailable: 0`,
`maxSurge: 1`) rolls in a fresh pod before terminating the old one,
so external auth traffic continues uninterrupted regardless of
replica count — the Service always has at least one Ready endpoint.
**In dev**, replicas are scaled to 1, but the rollout is still
zero-downtime for the same reason: the old pod is only terminated
after the surge pod is Ready. The dev-specific risk is the inverse:
if the spot pool has only one node and pod anti-affinity prevents
co-location, the surge pod will be Pending and the rollout will
stall while the old pod keeps serving (no 503s, but stuck
Deployment). The `--timeout=120s` on `rollout status` above will
catch this. If it expires, run `kubectl get events -n zitadel`
and look for `FailedScheduling`.

## Post-mitigation verification

```bash
# 1. The new pod is Ready.
kubectl get pods -n zitadel -l component=api

# 2. The healthz endpoint returns 200.
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  https://auth.dev.liverty-music.app/debug/healthz
# expected: 200

# 3. The OIDC discovery endpoint returns within steady-state latency
#    (sub-second).
time curl -sS -m 5 \
  https://auth.dev.liverty-music.app/.well-known/openid-configuration \
  > /dev/null
# expected: real time well under 1 s

# 4. The Cloud Monitoring p99 latency alert auto-closes within
#    ~5 minutes of the new pod handling traffic at normal speed.
gcloud alpha monitoring policies list \
  --project=liverty-music-dev \
  --filter='displayName="Zitadel OIDCService p99 latency"' \
  --format='value(conditions[0].name,enabled)'
# Visit Cloud Console → Monitoring → Alerting to confirm the
# incident is resolved.
```

## Escalation

Open an issue under `cloud-provisioning` (or comment on the existing
`self-hosted-zitadel` §18.6 follow-up) with:

1. Link to the alert in Cloud Monitoring.
2. The `INCIDENT_DIR` artifacts (zip and attach, or upload to a GCS
   bucket and link).
3. The pod's prior uptime (from `pod-describe.txt`) and a one-line
   summary of what state-changing API calls preceded the hang.

Escalate to upstream Zitadel maintainers (`zitadel/zitadel` issue
tracker) **only if**:

- The same shape recurs within 24 hours of restart, **AND**
- Forensic data captured does not match either §18.6 hypothesis A
  or B (genuinely new failure mode).

If the recurrence is consistent with hypothesis B and the
connection-pool dashboard panel confirms saturation, file the issue
with the connection-count time-series attached — that's the most
upstream-actionable signal.

## Related

- `openspec/changes/archive/<date>-zitadel-observability/` — the
  openspec change that introduced this runbook and the alerts that
  surface the §18.6 shape.
- `openspec/changes/self-hosted-zitadel/tasks.md` §18.6 — the
  original incident write-up.
- `k8s/namespaces/zitadel/overlays/dev/cronjob-restart-zitadel.yaml`
  — the band-aid weekly restart CronJob (capped frequency to ≤ 7d).
  Removing this band-aid is the goal of root-cause investigation.
