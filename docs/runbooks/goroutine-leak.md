# Runbook: Backend goroutine leak

> **Source of truth:** this runbook covers the capability documented in
> `specification/openspec/specs/goroutine-leak-detection/spec.md`.
> Update this file whenever the sampler, gauge, or alert changes.

## What this detects

Go 1.27 promoted the runtime `goroutineleak` profile to GA. It reports
goroutines **permanently blocked on a concurrency primitive** — a channel
operation, `sync.Mutex`, or `sync.Cond` — with no possibility of ever becoming
runnable. Each backend workload samples the profile on a coarse interval
(`GOROUTINE_LEAK_SAMPLE_INTERVAL`, default 2m) and publishes the count as the
OTel gauge `backend_goroutine_leak_count`, tagged with a `workload` label.

This is the additive safety net for the **silent-wedge class** — e.g. the
2026-07 consumer outage that wedged all event consumption for ~a week while the
pod stayed `Running` and emitted no ERROR/poison log, so no existing signal
fired.

## Alert

`Backend Goroutine Leak` (`alert-goroutine-leak`, `src/gcp/components/monitoring.ts`)
fires when `backend_goroutine_leak_count` stays **above zero for a full
10-minute window** (`ALIGN_MIN` over 600s) on any workload, and auto-closes when
it returns to zero. The metric flows OTLP → in-cluster otel-collector →
`googlecloud` exporter, so it lands in Cloud Monitoring as
`workload.googleapis.com/backend_goroutine_leak_count` (a standard custom
metric, not GMP/Prometheus) — hence a `conditionThreshold`, not a PromQL query.

## Triage

1. Read the `workload` label off the alert. It is the pod's
   `TELEMETRY_SERVICE_NAME`, which is NOT the same string as the pod `app`
   label — map it before selecting:

   | `workload` label            | pod `app` label   |
   | --------------------------- | ----------------- |
   | `liverty-music-backend`     | `fan-api`         |
   | `liverty-music-consumer`    | `event-consumer`  |

   ```bash
   kubectl -n backend get pods -l app=<app-label>   # e.g. app=fan-api
   ```
2. Pull a full profile with stacks from the **internal-only** pprof listener.
   It binds to `DEBUG_PORT` (default 6060) and is **not** attached to any
   Service, Gateway, or HTTPRoute, so it is unreachable from the public ingress
   — reach it only via port-forward:
   ```bash
   kubectl -n backend port-forward <pod> 6060:6060
   # then, in a browser or curl:
   #   http://localhost:6060/debug/pprof/goroutineleak?debug=2
   ```
   `debug=2` prints each leaked goroutine with its blocking stack, so you can
   pinpoint the exact channel/mutex/cond it is stuck on.
3. Correlate the blocking site with recent deploys or a stalled dependency.
4. Recover service by restarting the wedged pod while the root cause is fixed:
   ```bash
   kubectl -n backend delete pod <pod>
   ```

## Known blind spots (do NOT treat this alert as complete coverage)

The `goroutineleak` profile cannot see every hang. It is **additive to**, not a
replacement for, the backlog-stall and liveness signals:

- **Leaks reachable only via global variables** are not reported. A goroutine
  still referenced from a package-level variable is considered reachable, so the
  detector does not flag it.
- **Still-runnable goroutines** (spinning, busy-looping, or blocked on something
  that *could* unblock) are not reported — the profile only reports goroutines
  that can never make progress.
- **NATS-internal wedges** where "NATS isn't delivering" but no Go goroutine is
  blocked on a primitive are not reported. A stale/mis-bound durable can stop
  consumption without parking a goroutine.

For those failure modes, the complementary signals remain authoritative:

- **`Consumer JetStream Backlog Stall`** (`nats_consumer_num_pending` not
  draining for 15m) — catches consumption stalls regardless of goroutine state.
- **Consumer `/healthz` liveness** — restarts a pod whose router has stopped or
  whose expected durables are unbound.

If a wedge is suspected but this alert is silent, escalate to those signals
rather than assuming the process is healthy.
