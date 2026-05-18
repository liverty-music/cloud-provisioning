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

Cost recovery time when re-enabling: **~30–45 min** end-to-end (GKE create + Cloud SQL create + ArgoCD app-of-apps re-sync).

## Mental model — what gets torn down vs preserved

```
┌─ Pulumi.dev.yaml: workloadEnabled flag ───────────────────────────────┐
│                                                                        │
│   PRESERVED (always-on, ~¥300/mo)                                      │
│   ├─ ProjectComponent       project, folder, GSM secret shells*        │
│   ├─ NetworkComponent       VPC, DNS zones, certMap, static IP         │
│   ├─ Artifact Registry      backend + frontend Docker images           │
│   ├─ WorkloadIdentity       GitHub Actions OIDC                        │
│   ├─ GitHub repo bindings   env vars, status check policy              │
│   └─ Cost budget + billing alert (DORMANT — no billingAlertEmail seed) │
│                                                                        │
│   GUARDED (destroyed when flag=false)                                  │
│   ├─ KubernetesComponent    cluster, node pool, cluster-subnet         │
│   ├─ PostgresComponent      Cloud SQL instance, PSC endpoint, IAM      │
│   ├─ MonitoringComponent    log-based alert policies                   │
│   ├─ ZitadelMonitoringComponent  Zitadel SLO/latency alerts            │
│   ├─ Zitadel (orchestrator) cluster-dependent Zitadel infra            │
│   └─ SecretsComponent*      zitadel GSM bootstrap secret shells        │
│                                                                        │
│   * GSM secret *values* (the previously-populated masterkey,           │
│     admin-sa-key, login-pat) get destroyed with SecretsComponent so    │
│     the in-cluster bootstrap-uploader sidecar reseeds on restart.      │
└────────────────────────────────────────────────────────────────────────┘
```

## STOP — gotchas to know before shutdown

| Gotcha | Why it matters | Mitigation |
|---|---|---|
| **k8s Gateway → orphan GCLB resources** | `Gateway` is k8s-managed (ArgoCD) and the GCLB forwarding rule + target proxy are *derived* by the GKE Gateway controller. If the cluster is destroyed before the Gateway resource is cleaned up, the controller never runs the cleanup, and the GCP forwarding rule is orphaned outside Pulumi state — costing money silently. | **Pre-shutdown step 1 below.** Delete the k8s `Gateway` resource via `kubectl` *first* and wait for the controller to remove the GCLB forwarding rule before triggering Pulumi destroy. |
| **Subnet co-owned with cluster** | `cluster-subnet-osaka` is created inside `KubernetesComponent` (not `NetworkComponent`). When the cluster is destroyed, the subnet goes with it, dragging the PSC endpoint that lives in the same subnet. | Intentional — Postgres is in the guarded set anyway. Note: this couples the two on restart (one cannot exist without the other). |
| **Auto-pulumi-up on merge** | dev stack triggers `pulumi up` automatically on `src/**` merges. Once the PR is merged, the destroy is irreversible without `pulumi up` of the inverse change. | **`pulumi preview` is the only gate.** Review the preview output line-by-line *before* approving the PR — verify the destroy set matches the **Guarded** section exactly. |
| **State cascade footgun** | A misconfigured if-guard could cascade-remove unrelated resources via shared dependency edges (see [pulumi-state-recovery.md §13.4](pulumi-state-recovery.md) — 9 intended → 87 actual). | Preview shows the actual scope. If unexpected resources appear in the destroy set, **do not merge** — investigate dependency chain. |
| **Zitadel state loss** | dev Cloud SQL is destroyed → all Zitadel users / orgs / OAuth grants are gone. Pulumi-managed objects (admin org, OIDC clients, e2e test user) recreate on restart from `e2eTestUser.password` ESC value. Manual edits made via Zitadel Console *will not survive*. | Dev is treated as throwaway. If manual config matters, export before shutdown. |
| **Stack outputs become a sentinel string** | `webFrontendClientId` and `productOrgId` resolve to `"DEV_SHUTDOWN_workloadEnabled=false"` (the `DEV_SHUTDOWN_SENTINEL` const in `src/index.ts`) while `workloadEnabled=false`. Pulumi omits `undefined` outputs entirely and the `pulumi stack output <name>` call would hard-fail, so the sentinel keeps the key present. | Frontend CI / build pipelines that read these via `pulumi stack output webFrontendClientId` MUST compare against `DEV_SHUTDOWN_SENTINEL` and either fall back to the cached `.env.dev` value or skip the dev-targeted build step. Treating the sentinel as a real client id will produce non-functional OIDC redirects. |
| **`admin` Org `protect: true`** | The bootstrap-created admin Org has `protect: true` in `src/zitadel/index.ts` to prevent accidental destroy that would lock out all admins. The shutdown preview will **fail** with "resource cannot be deleted because it is protected." | **Step A4a below.** Run `pulumi state unprotect` against the admin Org URN before opening the disable PR. |
| **`adminOrgIdMap[dev]` stale after restart** | The dev admin Org ID is hardcoded in `src/zitadel/constants.ts` and used as `import:` to adopt the bootstrap-created org. After Cloud SQL wipe + re-bootstrap, Zitadel creates a *new* admin Org with a *new* ID; the hardcoded value no longer resolves and `pulumi up` blocks. | **Step B5a below.** After Zitadel boots in restart, query the new admin Org ID, update `adminOrgIdMap.dev`, commit, then let Pulumi proceed. |

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

On a feature branch in `cloud-provisioning`:

```yaml
# Pulumi.dev.yaml
environment:
  - liverty-music/dev
config:
  gcp:project: liverty-music-dev
  liverty-music:workloadEnabled: "false"  # ← add this line
```

Open the PR. Pulumi Cloud will post a `pulumi preview` comment with
the planned destroy set.

### A5. Review the preview — the critical gate

The preview comment must show **only** resources from the **Guarded**
set above. Verify:

- ✅ GKE cluster, node pool, cluster-subnet listed for destroy
- ✅ Cloud SQL `postgres-osaka` and its PSC endpoint listed for destroy
- ✅ Monitoring + ZitadelMonitoring alert policies listed for destroy
- ✅ Zitadel orchestrator resources + zitadel GSM secret shells listed for destroy
- ❌ **NOT** in the destroy set: GCP project, VPC, DNS zones, Artifact Registry, WIF, certMap, static IP, GitHub repo bindings, cost budget

If anything from the **Preserved** set is in the destroy plan, **stop
and investigate** — this is the [§13.4 cascade signal](pulumi-state-recovery.md).

### A6. Merge → auto pulumi up

Once the preview is verified and approved, merge to `main`. The
deployment runs automatically:

```bash
# Monitor.
open https://app.pulumi.com/pannpers/liverty-music/dev/deployments
```

Expected duration: **~5–10 min** (destroys are faster than creates).

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

### B6. Zitadel bootstrap-uploader reseed

The `bootstrap-uploader` sidecar on the first-instance Zitadel pod
detects empty GSM secret shells and populates them:

- `zitadel-masterkey` (re-generated)
- `zitadel-machine-key-for-pulumi-admin` (admin SA JWT key)
- `zitadel-login-pat` (Login V2 PAT)

```bash
kubectl -n zitadel logs <pod> -c bootstrap-uploader
# → expect: lines like "uploaded zitadel-machine-key-for-pulumi-admin"

# Confirm GSM secrets repopulated.
gcloud secrets versions list zitadel-machine-key-for-pulumi-admin \
  --project=liverty-music-dev --limit=3
```

> **If bootstrap-uploader idles without uploading**, the GSM secret
> shells already have populated versions from before — the sidecar
> only seeds when the shell is empty, so it goes silent and the
> restart hangs indefinitely waiting for `zitadel-machine-key-for-pulumi-admin`.
> Cause: the shutdown PR's `pulumi up` did not remove
> `SecretsComponent` (e.g. `workloadEnabled` was not actually `false`
> in state, or the secret values were imported outside the
> SecretsComponent path). Fix: manually destroy the affected secret
> versions and restart the Zitadel pod — the sidecar then takes the
> normal first-boot seed path.

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
