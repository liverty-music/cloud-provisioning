# Runbook: Zitadel projection-trigger wedge

> **Source of truth:** the Zitadel config in
> `k8s/namespaces/zitadel/base/values.yaml` (`Database.Postgres.MaxOpenConns`,
> `Projections.MaxParallelTriggers`) and the prod posture in
> `k8s/namespaces/zitadel/overlays/prod/values.yaml`. Update this file
> whenever either changes.

## TL;DR

**There is no automatic recovery.** The self-healing watchdog CronJob
(and its successor, a liveness-probe sidecar) were removed on 2026-08-19
(commit `c29837f`, OpenSpec change `retire-zitadel-wedge-watchdog`): the
CronJob restarted every replica at once, and the sidecar's liveness probe
restarted the sidecar instead of the wedged `zitadel` container. Detection
is manual, from user reports (the OIDCService latency alert in
`src/gcp/components/zitadel-monitoring.ts` is disabled).

Prod runs a **single `zitadel-api` replica** (commit `4836646`,
OpenSpec change `optimize-prod-gke-cost` D3), so a `rollout restart` is a
brief login outage, not a rolling no-op.

1. **Confirm the wedge with the auth-flow probe** (§Detection). Do not
   trust `/debug/healthz` or `/ui/v2/login/loginname`; both stay fast.
2. **Restart once** (§Manual mitigation) and re-run the probe.
3. **Restart fixed it** → classic in-process wedge (zitadel/zitadel#10103,
   §Shape A). Capture forensics if it recurs within 24 h.
4. **Restart did not fix it** (wedged again within seconds of boot) →
   trigger-worker deadlock replayed at boot (§Shape B). Check
   `Projections.MaxParallelTriggers` and `projections.current_states`.

---

## Detection: auth-flow probe

The probe must exercise `/ui/v2/login/login?authRequest=…`, which loads
the auth request via `AuthRequestByID` and therefore waits on a
projection trigger. A real `/oauth/v2/authorize` for the fan app
(client id from `k8s/namespaces/frontend/overlays/prod/fan-web-configmap.yaml`)
redirects there:

```bash
curl -sS -o /dev/null -L --max-time 40 \
  -w '%{http_code} %{time_total}s %{url_effective}\n' \
  "https://auth.liverty-music.app/oauth/v2/authorize?client_id=373015520582107291&redirect_uri=https%3A%2F%2Fliverty-music.app%2Fauth%2Fcallback&response_type=code&scope=openid&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
# Healthy: 200 in ~2 s, ending at /ui/v2/login/loginname?requestId=oidc_V2_…
# Wedged:  504 after ~30 s (the login?authRequest hop times out)
```

Each run creates one OIDC auth request; that is fine for manual use but
do not loop it. A browser sign-in at `https://liverty-music.app` is an
equivalent check.

---

## Wedge shapes

### Shape A: in-process wedge, restart fixes it (zitadel/zitadel#10103)

- Login returns 504 at `auth.liverty-music.app`; `ListProjectRoles` or
  `/oauth/v2/authorize` hangs past 10 s.
- `/debug/healthz` **still returns 200**; the wedge is in-process only.
- Cloud SQL `num_backends` is flat (no DB saturation).
- Typically appears after the pod has run for days; no recent upgrade.
- `kubectl rollout restart` clears it, and it stays clear.

### Shape B: trigger-worker deadlock replayed at boot (incident 2026-10-08)

Symptoms:

- `/ui/v2/login/login?authRequest=…` returns **504 after 30 s on every
  attempt**. `/ui/v2/login/loginname`, `/.well-known/openid-configuration`
  and `/oauth/v2/authorize` itself stay fast; `/debug/healthz` is 200.
- `zitadel` log: `query authRequest by ID … QUERY-Ou8ue … context canceled`.
- `zitadel-login` log: `Flow initiation failed … socket hang up` when the
  API pod is killed.
- **A restart does not help**: the wedge is back within seconds of boot.

Mechanism (Zitadel v4.17.1): with `Projections.MaxParallelTriggers`
unset, Zitadel sizes its projection-trigger worker pool as
`Database.MaxOpenConns / 3` (`internal/query/projection/projection.go`).
At `MaxOpenConns: 3` that was **one** worker. The notifications handler,
running on that worker, reduced a `user.human.password.changed` event and
awaited a nested trigger (`reducePasswordChanged` →
`NotificationPolicyByOrg(shouldTriggerBulk=true)` →
`Trigger(WithAwaitRunning())`) on the unbuffered queue it was itself
draining (`internal/eventstore/handler/v2/handler.go`, `queue` /
`StartWorkerPool`). Every later trigger hung, including `AuthRequestByID`
on each login. The spooler replays the unprocessed event at boot, so each
restart re-entered the deadlock.

Fix (PR #608, `k8s/namespaces/zitadel/base/values.yaml`):
`MaxOpenConns: 6`, `MaxIdleConns: 2`, `Projections.MaxParallelTriggers: 2`.
`MaxParallelTriggers` must stay **below** `MaxOpenConns` or Zitadel
refuses to start, and at least 2 so a reducer that awaits a nested trigger
has a second worker to run it.

If Shape B recurs with ≥2 workers, the next lever is raising
`MaxParallelTriggers` (and `MaxOpenConns` to keep it above). Cloud SQL is
db-f1-micro with a 25-connection cap shared with the other workloads; see
the budget comment next to `MaxOpenConns`.

#### Diagnosing Shape B in the database

Connect to the prod `zitadel` database through the `db-proxy` Pod
([`cloud-sql-access.md`](cloud-sql-access.md)) with `dbname=zitadel`. If
the local docker-compose Postgres already holds the local port, forward to
another one (e.g. `kubectl port-forward pod/db-proxy 25432:5432 -n backend`
and `port=25432`).

```sql
-- All last_updated values stop a few seconds after the last boot;
-- the stuck projection (2026-10-08: projections.notifications) sits at a
-- position before the newest events.
SELECT projection_name, position, last_updated
FROM projections.current_states
ORDER BY last_updated DESC;

-- During a hung login: no active zitadel session ...
SELECT pid, usename, state, wait_event_type, query_start, left(query, 80)
FROM pg_stat_activity
WHERE datname = 'zitadel' AND state <> 'idle';

-- ... and no advisory lock: the wait is in-process, not in the DB.
SELECT locktype, objid, pid, granted FROM pg_locks WHERE locktype = 'advisory';
```

Then confirm the running config:

```bash
kubectl get configmap -n zitadel -o yaml | grep -nE 'MaxParallelTriggers|MaxOpenConns'
```

---

## Manual mitigation

```bash
# Confirm you're targeting the right cluster
kubectl config current-context
# expected: gke_liverty-music-prod_asia-northeast2-a_...

kubectl rollout restart deployment/zitadel-api -n zitadel
kubectl rollout status deployment/zitadel-api -n zitadel --timeout=180s
```

Prod has one replica and no PDB, so login is unavailable until the new
pod is Ready (typically about a minute). Then re-run the probe; if it is
still 504, go to §Shape B.

---

## Post-mitigation verification

**Do NOT use `/debug/healthz` to verify recovery**; it returns 200
during both wedge shapes. Re-run the §Detection probe (expect 200 in
~2 s), or sign in at `https://liverty-music.app`. Re-check a few minutes
later: Shape B can look healthy for the first seconds after boot.

---

## Forensic data capture (for recurring wedges)

If the wedge recurs within 24 hours of restart, capture before mitigating:

```bash
INCIDENT_DIR="/tmp/zitadel-hang-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$INCIDENT_DIR"

kubectl logs -n zitadel deploy/zitadel-api -c zitadel --since=30m \
  > "$INCIDENT_DIR/zitadel-logs.txt"
kubectl logs -n zitadel deploy/zitadel-api-login --since=30m \
  > "$INCIDENT_DIR/zitadel-login-logs.txt"
kubectl describe pods -n zitadel \
  -l app.kubernetes.io/name=zitadel,app.kubernetes.io/component=start \
  > "$INCIDENT_DIR/pod-describe.txt"
kubectl get events -n zitadel --sort-by=.lastTimestamp \
  > "$INCIDENT_DIR/events.txt"

# Cloud SQL connection count
ONE_HOUR_AGO=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)
gcloud monitoring time-series list \
  --project=liverty-music-prod \
  --filter='metric.type="cloudsql.googleapis.com/database/postgresql/num_backends"' \
  --interval-end-time=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --interval-start-time="$ONE_HOUR_AGO" \
  --format=json > "$INCIDENT_DIR/sql-num-backends.json"

ls -la "$INCIDENT_DIR"
```

Also save the `projections.current_states` output from §Shape B.

---

## Wedge signature summary

| Signal | Shape A (#10103) | Shape B (trigger deadlock) | Other outages |
|---|---|---|---|
| Auth-flow probe (`login?authRequest`) | **hangs / 504** | **504 after 30 s** | fast error |
| `/ui/v2/login/loginname` | may hang | **fast** | varies |
| `/debug/healthz` | **200** (misleading) | **200** (misleading) | may be non-200 |
| Cloud SQL `num_backends` | **flat** | **flat** | may be elevated |
| `current_states.last_updated` | recent | **frozen seconds after boot** | varies |
| Restart fixes it | **yes** | **no** | depends |

---

## Related

- `k8s/namespaces/zitadel/base/values.yaml`: `MaxOpenConns` and
  `Projections.MaxParallelTriggers` with the Shape B rationale (PR #608).
- `k8s/namespaces/zitadel/overlays/prod/values.yaml`: single-replica
  posture and the launch-time HA restore.
- `openspec/changes/archive/2026-08-21-retire-zitadel-wedge-watchdog/`
  (specification): removal of the watchdog from the spec.
- [`cloud-sql-access.md`](cloud-sql-access.md): `db-proxy` access to the
  `zitadel` database.
- zitadel/zitadel#10103: upstream tracking issue for Shape A.
