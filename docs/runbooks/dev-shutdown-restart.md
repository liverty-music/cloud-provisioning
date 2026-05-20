# Runbook: dev environment shutdown / restart

> **When to use:** the dev environment is idle for an extended period
> (demo-only usage), and the fixed-cost layer (GKE Standard control
> plane, GCLB forwarding rule, Cloud SQL, PSC endpoint — ~¥6,200/mo
> combined) should be torn down to compress idle cost to ~¥300/mo.
>
> This runbook covers the **two-way switch** between active and
> shutdown states for the dev stack only. Prod is unaffected — the
> `workloadEnabled` flag is **dev-only** and `src/index.ts` aborts
> immediately if `prod` ever evaluates the program with the flag set
> to `false`, so a config-drift mishap cannot turn the cost switch
> into a prod-destruction button.

## Cost target

| State | Steady-state cost | What is running |
|---|---:|---|
| Active (`workloadEnabled: true`)   | ~¥7,000/mo | full dev stack |
| Shutdown (`workloadEnabled: false`) | **~¥300/mo** | Project / VPC / DNS / Artifact Registry / WIF / Cost budget |

Cost recovery time when re-enabling: **~20–30 min** end-to-end. Faster than the v1 design (~30–45 min) because Cloud SQL is STARTed (≈3 min) rather than re-provisioned (≈8–12 min) — the instance, disk, databases, and admin user are all preserved through the shutdown window.

## Mental model — what gets torn down vs preserved

```
┌─ Pulumi.dev.yaml: workloadEnabled flag ───────────────────────────────┐
│                                                                        │
│   PRESERVED (always-on, ~¥300/mo)                                      │
│   ├─ ProjectComponent       project, folder                            │
│   ├─ NetworkComponent       VPC, DNS zones, certMap, static IP         │
│   ├─ Artifact Registry      backend + frontend Docker images           │
│   ├─ WorkloadIdentity       GitHub Actions OIDC                        │
│   ├─ GitHub repo bindings   env vars, status check policy              │
│   ├─ Cost budget + billing alert (DORMANT — no billingAlertEmail seed) │
│   ├─ PostgresComponent      Cloud SQL *infrastructure*: instance,     │
│   │                          databases, postgres admin user, DNS A     │
│   │                          record. STOPped on shutdown               │
│   │                          (activationPolicy=NEVER) — CPU/RAM        │
│   │                          billing halts, disk + PITR backup remain. │
│   └─ SecretsComponent       Zitadel GSM containers + masterkey         │
│                              RandomString stay in state so the         │
│                              preserved Cloud SQL rows remain           │
│                              decryptable on restart.                   │
│                                                                        │
│   GUARDED (destroyed when flag=false)                                  │
│   ├─ KubernetesComponent    cluster, node pool, cluster-subnet,        │
│   │                          workload SAs + IAM bindings, K8s GSM      │
│   │                          secrets bound to those SAs                │
│   ├─ PSC consumer endpoint  forwarding rule + 10.10.10.10 address      │
│   │                          (created inside PostgresComponent under   │
│   │                          if (workloadEnabled), bound to            │
│   │                          cluster-subnet)                           │
│   ├─ Cloud SQL IAM users    backend-app + zitadel IAM SQL users        │
│   │                          (cluster SAs only; postgres admin user    │
│   │                          and human IAM users persist)              │
│   ├─ MonitoringComponent    log-based alert policies                   │
│   ├─ ZitadelMonitoringComponent  Zitadel SLO/latency alerts            │
│   ├─ Zitadel (orchestrator) Zitadel-provider resources — destroyed     │
│   │                          via API call to the in-cluster Zitadel,   │
│   │                          which deletes the Org/Project/Apps rows   │
│   │                          from the Cloud SQL Zitadel database       │
│   │                          even though the SQL instance survives.    │
│   └─ Secret IAM bindings    ESO + Zitadel SA reads on masterkey /      │
│                              admin-sa-key (the Secret containers       │
│                              themselves stay in PRESERVED).            │
└────────────────────────────────────────────────────────────────────────┘
```

> **Important nuance on data preservation:** "Cloud SQL preserved" means
> the **instance, disk, and backups** are not destroyed — the next
> restart skips the 8–12 min Cloud SQL provisioning step and the dev
> data has a physical home to come back to. But the **Zitadel
> orchestrator's destroy still calls the Zitadel API** (while the
> cluster is still alive in the destroy window) to delete each
> `Org` / `Project` / `ApplicationOidc` / etc. row. So the *Zitadel
> application data* inside Cloud SQL is wiped, even though the Cloud
> SQL infrastructure is preserved. The preserved `zitadel-masterkey`
> still matters because the freshly re-bootstrapped Zitadel on
> restart writes new rows encrypted with the **same** masterkey, so
> any out-of-band data (e.g. raw SQL exports kept across cycles)
> remains decryptable.

## STOP — gotchas to know before shutdown

| Gotcha | Why it matters | Mitigation |
|---|---|---|
| **k8s Gateway → orphan GCLB resources** | `Gateway` is k8s-managed (ArgoCD) and the GCLB forwarding rule + target proxy are *derived* by the GKE Gateway controller. If the cluster is destroyed before the Gateway resource is cleaned up, the controller never runs the cleanup, and the GCP forwarding rule is orphaned outside Pulumi state — costing money silently. | **Pre-shutdown step 1 below.** Delete the k8s `Gateway` resource via `kubectl` *first* and wait for the controller to remove the GCLB forwarding rule before triggering Pulumi destroy. |
| **Subnet co-owned with cluster** | `cluster-subnet-osaka` is created inside `KubernetesComponent` (not `NetworkComponent`). When the cluster is destroyed, the subnet goes with it, dragging the PSC consumer endpoint that lives in the same subnet. The Cloud SQL instance itself is unaffected (it's a separate, preserved resource); only the PSC access route is recreated on restart. | Intentional — PSC endpoint is structurally cluster-scoped. Restart recreates the same `10.10.10.10` forwarding rule pointing to the same provider-side service attachment. |
| **Auto-pulumi-up on merge** | dev stack triggers `pulumi up` automatically on `src/**` merges. Once the PR is merged, the destroy is irreversible without `pulumi up` of the inverse change. | **`pulumi preview` is the only gate.** Review the preview output line-by-line *before* approving the PR — verify the destroy set matches the **Guarded** section exactly. |
| **State cascade footgun** | A misconfigured if-guard could cascade-remove unrelated resources via shared dependency edges (see [pulumi-state-recovery.md §13.4](pulumi-state-recovery.md) — 9 intended → 87 actual). | Preview shows the actual scope. If unexpected resources appear in the destroy set, **do not merge** — investigate dependency chain. |
| **Zitadel application data loss (DB infra survives)** | Cloud SQL infrastructure is preserved (instance + disk + backups), but the Zitadel orchestrator destroy phase calls the Zitadel API while the cluster is still alive to delete each Org / Project / ApplicationOidc / etc. row. The Zitadel-side data in Cloud SQL is wiped even though Cloud SQL itself is not destroyed. Pulumi-managed objects (admin org, OIDC clients, e2e test user) recreate on restart from `e2eTestUser.password` and the rest of ESC. Manual edits made via Zitadel Console *will not survive*. | Dev is treated as throwaway for application data; infra preservation just saves the Cloud SQL provisioning time on restart. If manual Zitadel config matters, export before shutdown. |
| **Stack outputs become a sentinel string** | `webFrontendClientId` and `productOrgId` resolve to `"DEV_SHUTDOWN_workloadEnabled=false"` (the `DEV_SHUTDOWN_SENTINEL` const in `src/index.ts`) while `workloadEnabled=false`. Pulumi omits `undefined` outputs entirely and the `pulumi stack output <name>` call would hard-fail, so the sentinel keeps the key present. | Frontend CI / build pipelines that read these via `pulumi stack output webFrontendClientId` MUST compare against `DEV_SHUTDOWN_SENTINEL` and either fall back to the cached `.env.dev` value or skip the dev-targeted build step. Treating the sentinel as a real client id will produce non-functional OIDC redirects. |
| **`admin` Org `protect: true`** | The bootstrap-created admin Org has `protect: true` in `src/zitadel/index.ts` to prevent accidental destroy that would lock out all admins. The shutdown preview will **fail** with "resource cannot be deleted because it is protected." | **Step A4a below.** Run `pulumi state unprotect` against the admin Org URN before opening the disable PR. |
| **`adminOrgIdMap[dev]` stale after restart** | The dev admin Org ID is hardcoded in `src/zitadel/constants.ts` and used as `import:` to adopt the bootstrap-created org. After Cloud SQL wipe + re-bootstrap, Zitadel creates a *new* admin Org with a *new* ID; the hardcoded value no longer resolves and `pulumi up` blocks. | **Step B5a below.** After Zitadel boots in restart, query the new admin Org ID, update `adminOrgIdMap.dev`, commit, then let Pulumi proceed. |
| **Shutdown race: Cloud SQL stop vs Zitadel destroy** | The Zitadel orchestrator destroy phase makes HTTP API calls into the in-cluster Zitadel (which writes to Cloud SQL) at the same time Pulumi is applying `activationPolicy: NEVER` to the Cloud SQL instance. Default Pulumi parallelism (10) interleaves these. If GCP completes the Cloud SQL stop before Zitadel's API calls finish, the orchestrator destroys fail mid-flight, leaving rows in a partial-delete state and Pulumi state with pending-delete entries. The permanent code-side fix (`dependsOn: [postgresInstance]` on the Zitadel provider) is tracked in [#287](https://github.com/liverty-music/cloud-provisioning/issues/287). | **Step A5b below.** Until #287 lands, treat the shutdown's auto `pulumi up` as best-effort. Monitor the deployment; if Zitadel resource deletes fail, recover with `pulumi state delete --target <urn>` per stuck resource (NOT `--target-dependents` — see [pulumi-state-recovery.md §13.4](pulumi-state-recovery.md)) and re-trigger the deployment. |
| **Stale `zitadel-machine-key-for-pulumi-admin` on restart hangs Zitadel auth silently** | The Secret container persists in `SecretsComponent` (PRESERVED tier); the version populated by the previous boot's bootstrap-uploader also persists. After restart, Zitadel re-bootstraps and generates a new admin SA key — the stored GSM version no longer matches, but the sidecar's "only seed if shell is empty" logic sees a populated shell and skips. Pulumi reads the stale value, auth-as-pulumi-admin against Zitadel fails, and `pulumi up` errors with a 401 with no obvious root cause. **Only `zitadel-machine-key-for-pulumi-admin` is affected** — `zitadel-machine-key-for-backend-app` and `zitadel-login-pat` live in `KubernetesComponent` (GUARDED tier), so they are destroyed + recreated by Pulumi each cycle with the fresh Zitadel orchestrator's output, no manual step needed. | **Step B6 below.** Manually `gcloud secrets versions destroy` the stale `zitadel-machine-key-for-pulumi-admin` version **before** bouncing the Zitadel pod, then verify with `gcloud secrets versions list ... --filter="state=ENABLED"` that the new version's `createTime` is post-restart. |

---

## Procedure A — Shutdown (Active → `workloadEnabled: false`)

### A1. Pre-flight

```bash
# Confirm no merge freeze, no in-flight demos.
gh issue list --repo liverty-music/cloud-provisioning --label "blocks-shutdown"

# Capture any state worth keeping (optional).
gcloud sql export sql postgres-osaka gs://<bucket>/dev-snapshot-$(date +%Y%m%d).sql \
  --project=liverty-music-dev --database=<db>
```

> **Cloud SQL tier check is no longer restart-critical.** As of PR #283,
> the Cloud SQL instance is STOPped (`activationPolicy: NEVER`), not
> destroyed, so restart does not recreate it and the existing
> `db-f1-micro` tier is reactivated rather than re-provisioned. The
> tier-deprecation footgun from the previous design (fresh instances
> getting `db-f1-micro` rejected) does not apply. If `db-f1-micro` is
> ever forcibly retired by GCP for *running* instances, that becomes a
> separate hot-fix issue independent of this runbook.

### A2. Delete the k8s Gateway and wait for GCLB cleanup

The Gateway controller runs in-cluster, so this MUST complete before the cluster is destroyed.

```bash
# Use the dev cluster context.
gcloud container clusters get-credentials standard-cluster-osaka \
  --zone=asia-northeast2-a --project=liverty-music-dev

kubectl delete gateway -n gateway external-gateway

# Wait until the controller releases the forwarding rule.
# Expected: ~2–5 min. Polls every 10s.
until [ -z "$(gcloud compute forwarding-rules list \
    --project=liverty-music-dev \
    --filter='name~gkegw' --format='value(name)')" ]; do
  echo "waiting for GKE Gateway controller to remove forwarding rule..."
  sleep 10
done
echo "OK — no gkegw forwarding rules remain"
```

> If the loop runs >10 min, the controller may already be unhealthy.
> Check `kubectl -n gke-system logs` for the Gateway controller and
> escalate before proceeding — manual cleanup of orphan forwarding
> rules afterward is painful.

### A3. (Optional) Suspend ArgoCD app-of-apps

If you want ArgoCD to stop reconciling during the destroy window:

```bash
kubectl -n argocd patch application app-of-apps \
  --type=merge -p '{"spec":{"syncPolicy":null}}'
```

This is optional — when the cluster is destroyed, ArgoCD goes with it.

### A4a. Unprotect the `admin` Zitadel Org

The bootstrap-created admin Org is marked `protect: true` in code as a
guardrail against accidental destroys (commit history: ["pulumi destroy
against this resource would lock everyone out"](../../src/zitadel/index.ts)).
Shutdown is a *deliberate* destroy, so unprotect it once, immediately
before opening the disable PR:

```bash
pulumi stack select dev
pulumi state unprotect \
  'urn:pulumi:dev::liverty-music::zitadel:index/org:Org::admin'
```

> **Why not `protect: false` in code?** The flag is permanent state-side
> guardrail. Toggling it only at shutdown time is the same pattern as
> Cloud SQL's `deletionProtection: environment !== 'dev'` — the
> destroyer accepts the risk explicitly, in the same change window.

### A4. Open the shutdown PR

The feature code (the `workloadEnabled` flag itself and the
component if-guards) lands separately from this flip — see PR #278
in `cloud-provisioning`. The merge-triggers-destroy step is gated
behind a **single-line config change** so the operator owns the
decision and timing:

```yaml
# Pulumi.dev.yaml
environment:
  - liverty-music/dev
config:
  gcp:project: liverty-music-dev
  liverty-music:workloadEnabled: "false"  # ← add this line
```

Open the PR with **only** this YAML change (no `src/**` edits) so
the destroy diff is exactly the 142-resource Guarded set and
nothing else. Pulumi Cloud will post a `pulumi preview` comment
with the planned destroy set.

> **Auto-deploy trigger:** the dev stack's Pulumi Cloud Deployment
> trigger paths include both `src/**` and `Pulumi.dev.yaml`, so the
> single-line YAML change in this PR is sufficient to fire `pulumi
> up` on merge. Verify with `pulumi deployment settings pull` if
> ever in doubt — the `gitHub.paths` list must contain
> `Pulumi.dev.yaml` for this runbook to function.

### A5. Review the preview — the critical gate

The preview comment must show **only** resources from the **Guarded**
set above. Verify:

- ✅ GKE cluster, node pool, cluster-subnet listed for destroy
- ✅ PSC consumer endpoint (forwarding rule + 10.10.10.10 address) listed for destroy
- ✅ Cluster-SA Cloud SQL IAM users (`backend-app`, `zitadel`) listed for destroy
- ✅ Monitoring + ZitadelMonitoring alert policies listed for destroy
- ✅ Zitadel orchestrator resources listed for destroy (API delete clears the Cloud SQL Zitadel rows while the cluster is still up)
- ✅ Secret IAM bindings on `zitadel-masterkey` + `zitadel-machine-key-for-pulumi-admin` listed for destroy
- ✅ `gcp:sql:DatabaseInstance postgres-osaka` listed as **update** (not destroy) with `~settings.activationPolicy: ALWAYS → NEVER`
- ❌ **NOT** in the destroy set: GCP project, VPC, DNS zones, Artifact Registry, WIF, certMap, static IP, GitHub repo bindings, cost budget, Cloud SQL instance, Cloud SQL databases (`liverty-music`, `zitadel`), postgres admin user, `zitadel-masterkey` Secret + Version, `zitadel-machine-key-for-pulumi-admin` Secret

If anything from the **Preserved** set is in the destroy plan, **stop
and investigate** — this is the [§13.4 cascade signal](pulumi-state-recovery.md).

### A5b. Race-condition mitigation plan (Zitadel destroy ↔ Cloud SQL stop)

Pulumi Cloud Deployments cannot be invoked with `--parallel 1`, so the
default parallelism (10) lets Pulumi start `activationPolicy: NEVER`
on Cloud SQL concurrently with the Zitadel orchestrator destroys.
Zitadel's destroy phase makes HTTP API calls into the in-cluster
Zitadel pod, which writes to the same Cloud SQL instance — if Cloud
SQL becomes unreachable mid-flight, the API calls fail and Pulumi
leaves the failed resources in a pending-delete state.

**Before merging the shutdown PR**, open a second terminal pointed at
the deployment monitor and have this recovery command ready:

```bash
# Recovery: for each Zitadel resource still in state after a failed
# pulumi up, remove it without an API call. NEVER pass
# `--target-dependents` here (see §13.4 in pulumi-state-recovery.md).
pulumi state delete --target 'urn:pulumi:dev::liverty-music::zitadel:index/org:Org::<name>' --yes
```

Recovery sequence if the auto-deploy fails:
1. Read the deployment failure log; identify each Zitadel resource left
   in `failed` state.
2. `pulumi state delete --target <urn>` for each (no cascade flag).
3. Re-trigger the deployment via the Pulumi Cloud UI ("Retry"). With
   Zitadel state pointers gone, the remaining destroys complete
   cleanly.

**Pre-emptive option (slower but race-free)** — destroy Zitadel in
its own pre-shutdown step:

```bash
# Run this BEFORE merging the shutdown PR, while the cluster is up.
# `pulumi state delete` per-resource (no cascade) clears Zitadel from
# state without API calls. The actual Zitadel rows will be wiped when
# the cluster goes down anyway; we just teach Pulumi to skip the
# destroy phase entirely.
#
# Filter on `.type` (not `.urn`) so we don't accidentally match
# children of Zitadel components — e.g. the `zitadel-masterkey` GSM
# Secret created inside `SecretsComponent` has URN suffix
# `::zitadel:liverty-music:Secrets$gcp:secretmanager/secret:Secret::zitadel-masterkey`
# which would be hit by a substring URN filter but has type
# `gcp:secretmanager/secret:Secret`, not `zitadel:*`. Filtering by
# `.type` keeps the preserved GSM containers safe.
for urn in $(pulumi stack export | jq -r '
  .deployment.resources[]
  | select(.type | startswith("zitadel:") or . == "pulumi:providers:zitadel")
  | .urn
'); do
  echo "deleting $urn"
  pulumi state delete --target "$urn" --yes
done
```

Sanity-check before running the loop — preview the list:

```bash
pulumi stack export | jq -r '
  .deployment.resources[]
  | select(.type | startswith("zitadel:") or . == "pulumi:providers:zitadel")
  | {urn, type}
'
```

Every entry should be either a `zitadel:index/*` resource (Zitadel API
object), a `zitadel:liverty-music:*` component, or the
`pulumi:providers:zitadel` provider itself. If any other type shows
up, **stop** — the filter is too broad.

This is operational overhead. The permanent fix — adding
`dependsOn: [postgresInstance]` to the Zitadel provider so Pulumi
destroy walks Zitadel → cluster → Cloud SQL stop in dependency
order — requires a Gcp-first / Zitadel-second construction reorder
and is tracked separately as
[issue #287](https://github.com/liverty-music/cloud-provisioning/issues/287).
This runbook step is the interim mitigation until that lands.

### A6. Merge → auto pulumi up

Once the preview is verified and approved, merge to `main`. The
deployment runs automatically:

```bash
# Monitor.
open https://app.pulumi.com/pannpers/liverty-music/dev/deployments
```

Expected duration: **~5–10 min** (destroys are faster than creates).
If the deployment fails on Zitadel resources, apply the
A5b recovery sequence.

### A7. Post-shutdown verification

```bash
# Confirm fixed-cost resources are gone.
gcloud container clusters list --project=liverty-music-dev
# → expect: Listed 0 items.

gcloud sql instances list --project=liverty-music-dev
# → expect: Listed 0 items.

gcloud compute forwarding-rules list --project=liverty-music-dev \
  --filter='name~gkegw'
# → expect: Listed 0 items. (orphan check)

gcloud compute forwarding-rules list --project=liverty-music-dev \
  --filter='name~psc-endpoint'
# → expect: Listed 0 items.

# Confirm preserved set still exists.
gcloud artifacts repositories list --project=liverty-music-dev
# → expect: backend + frontend repos still listed
```

Watch billing over the next 2 days to confirm the daily run-rate
drops to ~¥10–15/day (≈¥300/mo).

---

## Procedure B — Restart (Shutdown → `workloadEnabled: true`)

> **Restart is a two-PR sequence by design, not a single merge.**
> The first PR flips the flag → auto `pulumi up` rebuilds GKE +
> Cloud SQL + boots a fresh Zitadel instance → **`pulumi up` then
> fails at the admin Org import** because the hardcoded
> `adminOrgIdMap[dev]` in `src/zitadel/constants.ts` no longer
> matches the freshly bootstrapped Org ID (Cloud SQL wipe creates
> a new ID). A second PR updates that constant; auto-deploy runs
> again and completes the restart. Plan for ~30–45 min of
> half-up state between the two merges. See step B4a for the ID
> lookup script. (Future improvement tracked in a follow-up
> issue: lift `adminOrgId` to ESC so the restart self-heals
> without the second PR.)

### B1. Pre-flight

```bash
# Confirm preserved resources are still intact.
gcloud projects describe liverty-music-dev
gcloud artifacts repositories list --project=liverty-music-dev
gcloud certificate-manager maps list --project=liverty-music-dev \
  --location=global
```

### B2. Open the restart PR

Revert `Pulumi.dev.yaml`:

```yaml
config:
  gcp:project: liverty-music-dev
  liverty-music:workloadEnabled: "true"
```

### B3. Review the preview

The preview should show creates only — *no destroys*, *no replaces*.
Resources to expect creating:

- GKE cluster + node pool + cluster-subnet
- Cloud SQL instance + PSC endpoint + IAM bindings + DB users
- Monitoring + ZitadelMonitoring alert policies
- Zitadel orchestrator resources (Zitadel project, OIDC apps, login policy, e2e test user)
- Zitadel GSM secret shells (empty — bootstrap-uploader populates on first boot)

### B4. Merge → auto pulumi up

```bash
# Monitor.
open https://app.pulumi.com/pannpers/liverty-music/dev/deployments
```

Expected timing:
- GKE cluster create: ~8–12 min
- Cloud SQL create: ~8–12 min (runs in parallel)
- Pulumi up overall: ~15–20 min

### B4a. Refresh `adminOrgIdMap[dev]` (will appear in the preview)

The first `pulumi up` after restart proceeds far enough to create the
GKE cluster + Cloud SQL + boot Zitadel, then *fails* attempting to
import the admin Org because the hardcoded ID in
`src/zitadel/constants.ts` no longer exists in the freshly bootstrapped
Zitadel database. Fix in two steps:

Reuse the JWT-bearer flow from [`zitadel-break-glass.md`
step 2](zitadel-break-glass.md) — it is the same SA key path,
just paired with an `orgs/_search` query that filters by org name.
Inline copy with the org-name filter:

```bash
gcloud secrets versions access latest \
  --secret=zitadel-machine-key-for-pulumi-admin \
  --project=liverty-music-dev > /tmp/zitadel-machine-key-for-pulumi-admin.json
```

```python
#!/usr/bin/env python3
# /tmp/zitadel-admin-org-id.py — mint JWT, exchange, look up admin Org ID.
import json, time, urllib.request
from base64 import urlsafe_b64encode
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ZITADEL = "https://auth.dev.liverty-music.app"

def b64url(d): return urlsafe_b64encode(d).rstrip(b"=").decode()
with open("/tmp/zitadel-machine-key-for-pulumi-admin.json") as f: key = json.load(f)
now = int(time.time())
header = {"alg":"RS256","typ":"JWT","kid":key["keyId"]}
payload = {"iss":key["userId"],"sub":key["userId"],"aud":ZITADEL,"iat":now,"exp":now+300}
h = b64url(json.dumps(header,separators=(",",":")).encode())
p = b64url(json.dumps(payload,separators=(",",":")).encode())
sig = serialization.load_pem_private_key(key["key"].encode(), password=None).sign(
    f"{h}.{p}".encode(), padding.PKCS1v15(), hashes.SHA256())
body = (
    "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer"
    f"&assertion={h}.{p}.{b64url(sig)}"
    "&scope=openid urn:zitadel:iam:org:project:id:zitadel:aud"
)
req = urllib.request.Request(f"{ZITADEL}/oauth/v2/token", data=body.encode(),
    headers={"Content-Type":"application/x-www-form-urlencoded"}, method="POST")
token = json.loads(urllib.request.urlopen(req).read())["access_token"]

# Find the admin org by exact name match.
req = urllib.request.Request(f"{ZITADEL}/admin/v1/orgs/_search",
    headers={"Authorization": f"Bearer {token}", "Content-Type":"application/json"},
    data=json.dumps({"queries":[{"nameQuery":{
        "name":"admin","method":"TEXT_QUERY_METHOD_EQUALS"
    }}]}).encode(), method="POST")
result = json.loads(urllib.request.urlopen(req).read())
print(result["result"][0]["id"])  # → e.g. 372456789012345678
```

```bash
python3 /tmp/zitadel-admin-org-id.py
# → 372456789012345678   (this is the new dev admin Org ID)
```

Then commit the new ID:

```ts
// src/zitadel/constants.ts
export const adminOrgIdMap: Record<Environment, string> = {
  dev: '372456789012345678',  // captured YYYY-MM-DD after dev restart
  prod: '372892288692584603',
}
```

Push, let auto `pulumi up` re-run, this time the import resolves.

### B5. ArgoCD bootstrap + app-of-apps sync

Once Pulumi finishes, ArgoCD is installed (via Pulumi) and the
app-of-apps Application reconciles every workload namespace:

```bash
gcloud container clusters get-credentials standard-cluster-osaka \
  --zone=asia-northeast2-a --project=liverty-music-dev

kubectl -n argocd get applications -w
# Wait for all to reach Synced + Healthy. Expected: ~10–15 min.
```

### B6. Zitadel bootstrap-uploader reseed — manual reseed of `zitadel-machine-key-for-pulumi-admin`

The `bootstrap-uploader` sidecar only writes a new version to a GSM
secret if the existing shell is **empty**. As of PR #283 (`Path 2`
design), the four Zitadel-related GSM secrets fall into two groups:

| Secret | Created in | Behavior across cycle | Sidecar action on restart |
|---|---|---|---|
| `zitadel-masterkey` | `SecretsComponent` (PRESERVED tier) | Pulumi-managed RandomString + SecretVersion both stay in state. The same value is reused so Zitadel can decrypt any pre-existing rows. | Sees a populated shell, **skips** — correct, the stored value is the right one. |
| `zitadel-machine-key-for-pulumi-admin` | `SecretsComponent` (PRESERVED tier) | Secret container persists; the **version** populated by the previous boot's sidecar also persists. But the Zitadel orchestrator destroy in the shutdown cycle deleted the corresponding `pulumi-admin` MachineUser + MachineKey rows from the Cloud SQL Zitadel DB. On restart, Zitadel re-bootstraps and generates a **new** admin SA key whose JSON doesn't match the stored version. | Sees a populated shell, **skips** — but the stored key is stale. **Manual step required: destroy the stale version so the sidecar reseeds with the new key.** |
| `zitadel-machine-key-for-backend-app` | `KubernetesComponent.secrets[]` (GUARDED tier) | Destroyed with the cluster, re-created on restart by Pulumi using the *new* `zitadel.machineKeyDetails` output of the freshly-bootstrapped Zitadel orchestrator. The GSM Secret + Version are both Pulumi-managed; no sidecar involvement. | Not applicable — value is correct from creation. |
| `zitadel-login-pat` | `KubernetesComponent.esoOnlySecrets[]` (GUARDED tier) | Same shape as `zitadel-machine-key-for-backend-app` — Pulumi destroys and recreates from `zitadel.loginClientToken`. | Not applicable — value is correct from creation. |

Only the **first row's `zitadel-machine-key-for-pulumi-admin`** needs
the manual destroy-and-reseed; the other three sort themselves out
through their respective normal paths.

```bash
# Disable the stale version so the sidecar re-seeds on next pod boot.
gcloud secrets versions list zitadel-machine-key-for-pulumi-admin \
  --project=liverty-music-dev --limit=3
gcloud secrets versions destroy <VERSION> \
  --secret=zitadel-machine-key-for-pulumi-admin \
  --project=liverty-music-dev --quiet

# Bounce the first-instance Zitadel pod so the sidecar re-runs.
kubectl -n zitadel rollout restart deployment zitadel-api
kubectl -n zitadel logs -l app=zitadel-api -c bootstrap-uploader --tail=50
# → expect: "uploaded zitadel-machine-key-for-pulumi-admin"
```

**Validation gate — verify the new version's `createTime` is
post-restart** (catches the silent skip case where the sidecar saw a
populated shell and didn't reseed):

```bash
gcloud secrets versions list zitadel-machine-key-for-pulumi-admin \
  --project=liverty-music-dev \
  --filter="state=ENABLED" \
  --format="table(name,createTime,state)"
```

If the ENABLED version's `createTime` predates the cluster restart,
the sidecar skipped the reseed (it still sees a populated shell). Go
back to the `gcloud secrets versions destroy` step above, ensure no
ENABLED version remains, and bounce the pod again.

> **Why not destroy these in the Pulumi shutdown PR directly?** The
> SecretVersions are written by the in-cluster sidecar via the GCP API,
> not by Pulumi — they're not in Pulumi state. They have to be cleared
> via `gcloud secrets versions destroy` on the operator side. A future
> improvement could be a Pulumi `Command` resource that runs this on
> shutdown automatically, but that's out of scope for now.

### B6b. Capture the new dev Zitadel instance id

After the Cloud SQL wipe + re-bootstrap, Zitadel creates a **new instance with a new id** (same chicken-and-egg as `adminOrgIdMap[dev]` in §B4a, just one layer up). `instanceIdMap[dev]` in `src/zitadel/constants.ts` still holds the `__UNSET__` sentinel from the dev-shutdown era. Without this step, the next `pulumi up` would hit the `ZitadelInstanceCustomDomain` Dynamic Resource's fail-fast guard with:

> `ZitadelInstanceCustomDomain: instanceId is the __UNSET__ sentinel. Run \`node scripts/discover-zitadel-instance-id.mjs --env=dev\` ...`

Run the discovery script from `cloud-provisioning/`:

```bash
node scripts/discover-zitadel-instance-id.mjs --env=dev
```

The script signs a `pulumi-system` System User JWT using the private key in GSM (`zitadel-system-api-key`) and prints the captured id ready to paste:

```
[discover] paste this into src/zitadel/constants.ts (instanceIdMap):
  dev: '<NEW_INSTANCE_ID>',
```

Update `instanceIdMap[dev]` in `src/zitadel/constants.ts`, commit, and let Pulumi proceed. The Dynamic Resource will then call `AddCustomDomain` to re-register `zitadel-api.zitadel.svc.cluster.local` against the new instance — same idempotent path the prod Phase 2 took.

> **Prerequisite for this step**: the `pulumi-system` System User must already be loaded on the `zitadel-api` Pod. That happens automatically as part of B5's ArgoCD sync (the `external-secret-system-api-pub` ExternalSecret + the `ZITADEL_SYSTEMAPIUSERS` env on `deployment-api.yaml` are in base). Wait for `kubectl get pods -n zitadel -l component=api` to show 1/1 Ready before running the script.

### B7. End-to-end smoke

```bash
# 1. DNS resolves.
dig +short dev.liverty-music.app
dig +short api.dev.liverty-music.app

# 2. Gateway health (auth-exempt — see reference_liverty_dev_endpoints.md memory).
curl -s https://api.dev.liverty-music.app/grpc.health.v1.Health/Check | jq

# 3. Frontend loads.
curl -s -o /dev/null -w '%{http_code}\n' https://dev.liverty-music.app

# 4. Re-capture Playwright e2e auth (see reference_e2e_auth.md memory).
cd frontend && npm run e2e:auth-capture
```

---

## Notes

### Cloud SQL `liverty-music` / `zitadel` databases are not deletion-protected

Only the Cloud SQL **instance** has the two-layer guard (`deletionProtection: true`
Pulumi-side + `deletionProtectionEnabled: true` Cloud SQL-side). The individual
databases (`liverty-music` and `zitadel`) inside the instance have no
protection flag — they can be dropped with `gcloud sql databases delete
zitadel --instance=postgres-osaka` or `pulumi state delete <db-urn>`. Low
risk in practice (requires a deliberate action against a specific resource),
but worth knowing during incident response.

### Prod decommission requires a manual API-disable pass

The `disableOnDestroy: false` setting on all `gcp.projects.Service`
resources (changed in PR #283) is correct for the dev shutdown cycle. The
trade-off: when the prod project is eventually decommissioned, a manual
`gcloud services disable` pass is required before the GCP project itself
can be deleted cleanly — Pulumi destroy will not flip these APIs off.

## Troubleshooting

### Orphan GCLB forwarding rules after shutdown

Symptom: `gcloud compute forwarding-rules list --filter='name~gkegw'` shows
rules after Pulumi destroy.

Cause: A2 (delete k8s Gateway) was skipped, or the GKE Gateway controller
crashed before completing cleanup.

Fix:
```bash
# Identify and delete each one explicitly.
gcloud compute forwarding-rules list --project=liverty-music-dev \
  --filter='name~gkegw' --format='value(name,region)'

gcloud compute forwarding-rules delete <name> \
  --project=liverty-music-dev --global  # or --region=<region>

# Also check target proxies, URL maps, backend services.
gcloud compute target-https-proxies list --project=liverty-music-dev
gcloud compute url-maps list --project=liverty-music-dev
gcloud compute backend-services list --project=liverty-music-dev
```

### Restart Pulumi up fails on Cloud SQL create

Symptom: `db-f1-micro` tier rejection.

Cause: `db-f1-micro` is deprecated; GCP may force a new tier (e.g.,
`db-perf-optimized-N-1`) for fresh dev instances.

Fix: update `src/gcp/components/postgres.ts` tier, follow up in a
separate PR. Reference the GCP deprecation notice in the PR description.

### ArgoCD app-of-apps stuck OutOfSync

See [pulumi-state-recovery.md](pulumi-state-recovery.md) for related cascade
recovery. For normal ArgoCD sync issues post-restart, check the per-app
status:

```bash
kubectl -n argocd describe application <app-name>
```

Common causes after a fresh restart:
- ESO ClusterSecretStore not yet ready → Atlas migrations retry → eventually self-heals
- backend image pull fails → check Artifact Registry IAM binding survived the cycle
