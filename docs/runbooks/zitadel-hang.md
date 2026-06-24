# Runbook: Zitadel projection-trigger wedge

> **Source of truth:** this runbook covers the wedge shape documented in
> `specification/openspec/specs/zitadel-self-hosted-deployment/spec.md`
> → "Self-healing watchdog auto-restarts a wedged Zitadel API" requirement.
> Update this file whenever the watchdog or detection signal changes.

## TL;DR (self-healing first)

**Since 2026-06-23** a watchdog CronJob runs every minute in prod:
`k8s/namespaces/zitadel/overlays/prod/cronjob-watchdog-zitadel.yaml`

If login is broken, **check the watchdog job history first** before
taking manual action:

```bash
# Most-recent watchdog run
kubectl get jobs -n zitadel -l component=self-healing \
  --sort-by=.metadata.creationTimestamp | tail -3

# Logs for the most-recent job pod
kubectl logs -n zitadel \
  -l app=zitadel,component=self-healing --tail=50
```

If you see `restarting deployment/zitadel-api ...` or
`WATCHDOG_DRY_RUN=true — would run: kubectl rollout restart`, the
watchdog detected the wedge. Wait 2–3 min for the restart to finish,
then **verify recovery via an auth-flow probe** (see §Post-mitigation
below) — NOT via `/debug/healthz` (it stays 200 during the wedge).

If the watchdog is not firing or is stuck, continue to §Manual
mitigation.

---

## When this runbook applies

The **wedge shape** (zitadel/zitadel#10103) exhibits:

- Login returns 504 at `auth.liverty-music.app`.
- `ListProjectRoles` or `/oauth/v2/authorize` hangs past 10 s.
- `/debug/healthz` **still returns 200** — the wedge is in-process only.
- Cloud SQL `num_backends` is flat (no DB saturation).
- No recent Zitadel upgrade; the same version has been running for ≥3 days.

The watchdog detects the wedge using a **read-only
`ProjectService/ListProjectRoles` probe** (`POST
auth.liverty-music.app/zitadel.project.v2.ProjectService/ListProjectRoles`
with `Authorization: Bearer <watchdog-PAT>`). That method internally
triggers `ProjectRoleProjection.Trigger(WithAwaitRunning())` — the same
projection observed wedging on 2026-06-23. A hang = wedge signal; a fast
200 = healthy.

**The probe is read-only** — it creates no OIDC auth requests in the
eventstore (unlike the prior authorize-based probe). The ~1440/day
auth-request accumulation is eliminated.

If `ListProjectRoles` returns `401`/`403` the watchdog logs
"watchdog credential invalid" and skips the restart — fail-safe, but
detection is degraded. Check the watchdog PAT (see §Credential health).

---

## Watchdog PAT credential health

The watchdog authenticates with a long-lived PAT for machine user
`watchdog-probe` (least-privilege `PROJECT_OWNER_VIEWER` on the
`liverty-music` product project, provisioned by Pulumi
`WatchdogProbeComponent`). The PAT is synced from GSM
`zitadel-watchdog-probe-pat` via ExternalSecret into K8s Secret
`zitadel-watchdog-probe-pat` in the `zitadel` namespace.

If the watchdog logs "watchdog credential invalid":

```bash
# Confirm the K8s Secret exists and is populated
kubectl get secret zitadel-watchdog-probe-pat -n zitadel \
  -o jsonpath='{.data.token}' | base64 -d | head -c 20
# Should print the first 20 chars of the PAT

# Confirm ESO synced successfully
kubectl get externalsecret zitadel-watchdog-probe-pat -n zitadel
# STATUS should be Ready / SecretSynced

# Check PAT expiry in the Zitadel Admin Console:
#   https://auth.liverty-music.app/ui/console
#   → Organizations → admin → Users → watchdog-probe → Personal Access Tokens
# Current expiry: 2099-01-01 (far-future)
```

If the PAT is expired or revoked, re-provision via `pulumi up` on the
prod stack (Pulumi `WatchdogProbeComponent` in
`src/zitadel/components/watchdog-probe.ts`). The ESO refresh interval
is 1h; force an immediate sync if needed:

```bash
kubectl annotate externalsecret zitadel-watchdog-probe-pat \
  -n zitadel force-sync=$(date +%s) --overwrite
```

---

## Manual mitigation (if watchdog does not auto-recover)

When the wedge is confirmed and the watchdog has not fired (or is in
dry-run mode):

```bash
# Confirm you're targeting the right cluster
kubectl config current-context
# expected: gke_liverty-music-prod_asia-northeast2-a_...

kubectl rollout restart deployment/zitadel-api -n zitadel
kubectl rollout status deployment/zitadel-api -n zitadel --timeout=120s
```

With 2 prod replicas the rolling restart is non-disruptive.

---

## Post-mitigation verification

**Do NOT use `/debug/healthz` to verify recovery** — it returns 200
during the wedge and does not change on restart. Verify via an
auth-flow probe instead:

```bash
# Verify the ListProjectRoles probe is fast (<2s) after restart
PAT=$(kubectl get secret zitadel-watchdog-probe-pat -n zitadel \
  -o jsonpath='{.data.token}' | base64 -d)
time curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://auth.liverty-music.app/zitadel.project.v2.ProjectService/ListProjectRoles \
  -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"373015520045170843"}'
# Expected: 200, real time well under 2 s

# Or verify via a real login attempt at https://liverty-music.app
```

---

## Forensic data capture (for recurring wedges)

If the wedge recurs within 24 hours of restart, capture before mitigating:

```bash
INCIDENT_DIR="/tmp/zitadel-hang-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$INCIDENT_DIR"

ZITADEL_POD=$(kubectl get pods -n zitadel -l component=api \
  -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n zitadel "$ZITADEL_POD" -c zitadel --since=30m \
  > "$INCIDENT_DIR/zitadel-logs.txt"
kubectl describe pod -n zitadel "$ZITADEL_POD" \
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

---

## Wedge signature summary

| Signal | During wedge | During other outages |
|---|---|---|
| `ListProjectRoles` (watchdog probe) | **hangs** (HTTP 000) | fast 401/503 |
| `/debug/healthz` | **200** (misleading) | may be non-200 |
| Cloud SQL `num_backends` | **flat** | may be elevated |
| Pod age | ≥ 3 days (typically) | any age |
| Restart fixes it | **yes** | depends |

---

## Related

- `openspec/changes/archive/*-zitadel-watchdog-readonly-probe/` — the
  OpenSpec change that introduced the read-only probe and this runbook.
- `k8s/namespaces/zitadel/overlays/prod/cronjob-watchdog-zitadel.yaml`
  — the watchdog CronJob manifest.
- `src/zitadel/components/watchdog-probe.ts` — Pulumi provisioning of
  the `watchdog-probe` machine user and PAT.
- zitadel/zitadel#10103 — upstream tracking issue (unfixed as of v4.14.0).
