# Dev vs Prod Differences

Developer-facing reference comparing every meaningful configuration
difference between the `liverty-music-dev` and `liverty-music-prod`
environments. Use this when reasoning about behavior gaps between
the two stacks.

Rationale and reversibility classification for each difference live in
[PROD_BOOTSTRAP_DECISIONS.md](./PROD_BOOTSTRAP_DECISIONS.md). The
"Irreversible vs reversible cluster settings" reference table is in
[GKE_CLUSTER_MODE_DECISION.md](./GKE_CLUSTER_MODE_DECISION.md).

Last updated: 2026-05-11.

## Comparison table

| Setting | dev | prod | Trigger to flip | Reversible? |
|---|---|---|---|---|
| **GKE cluster mode** | Standard | Standard | A new OpenSpec change | ❌ Requires new cluster + workload migration |
| **GKE topology** | Zonal (`asia-northeast2-a`) | Regional (`asia-northeast2`) | n/a | ❌ Irreversible |
| **Dataplane** | LEGACY_DATAPATH (kube-proxy / iptables) | ADVANCED_DATAPATH (Dataplane V2 / eBPF) | n/a | ❌ Irreversible (must set at creation) |
| **etcd Application-layer Secrets Encryption (CMEK)** | Off (Google default at-rest only) | On — Cloud KMS key `gke-etcd-encryption` | SOC2 / audit gate | ❌ Irreversible at cluster creation |
| **GKE deletion protection** | Off (`deletionProtection: false`) | On (`deletionProtection: true`) | Manual override only | ✅ Mutable (Pulumi config) |
| **Spot node pool min/max** | 1 / 3 nodes | 1 / 3 nodes | Workload count growth | ✅ Mutable (Pulumi config) |
| **Spot node machine type** | `e2-medium` | `e2-medium` | Workload sizing pressure | ✅ Replaceable (new node pool) |
| **Boot disk** | 30 GB `pd-standard` | 30 GB `pd-standard` | Image cache pressure / latency | ✅ Replaceable (new node pool) |
| **Boot disk CMEK** | Default Google encryption | Default Google encryption | Compliance gate | ✅ Replaceable (new node pool with CMEK) |
| **Node privacy** | `enablePrivateNodes: false` (public IPs) | `enablePrivateNodes: false` (public IPs) | First real users on prod | ✅ Mutable post-creation |
| **Cloud NAT** | Not provisioned | Not provisioned | When prod flips to private nodes | ✅ Add VPC-level resource |
| **Confidential GKE Nodes** | Off | Off | Blockchain mainnet GA → add dedicated signing node pool | ✅ Per-pool addition; cluster-level enable is ❌ irreversible |
| **Google Managed Prometheus (GMP)** | Disabled | Disabled | First real users on prod | ✅ Mutable |
| **Logging components** | `SYSTEM_COMPONENTS` + `WORKLOADS` | `SYSTEM_COMPONENTS` + `WORKLOADS` | n/a | ✅ Mutable |
| **Monitoring components** | `SYSTEM_COMPONENTS` only | `SYSTEM_COMPONENTS` only | Metric-based alerts need GMP first | ✅ Mutable |
| **kube-dns autoscaler override** | `preventSinglePointFailure: false` (replicas 1) | GKE default (replicas 2) | n/a | ✅ Mutable (k8s ConfigMap) |
| **Cloud SQL instance tier** | `db-f1-micro` | `db-f1-micro` | First real traffic on prod | ✅ Mutable (in-place tier upgrade with brief downtime) |
| **Cloud SQL availability** | ZONAL | REGIONAL | n/a | ❌ Set at instance creation (different prod instance) |
| **Cloud SQL deletionProtection** | Off | On | n/a | ✅ Mutable |
| **Cloud SQL databases** | `liverty_music` + `zitadel` | `liverty_music` + `zitadel` (infra provisioned, workload deferred) | n/a | ✅ Add database resource |
| **Zitadel infrastructure** (GCP SA, DB, IAM, cert, DNS for `auth.<host>`) | Provisioned via Pulumi | Provisioned via Pulumi (same as dev) — idle until the workload is deployed | n/a | n/a — already provisioned |
| **Self-hosted Zitadel workload** (Pulumi-managed Zitadel application + machine key + login PAT) | Provisioned via Pulumi (`src/index.ts:73` gate; depends on `zitadelMachineKey` / `zitadelLoginPat` ESC values) | Not deployed — ESC values are not set for prod, so the gate evaluates false | Future `self-hosted-zitadel-prod` follow-up change provides the ESC values and removes the implicit gate | ⚠️ Requires ESC config + Pulumi change |
| **Domain authority for `liverty-music.app` apex** | Cloudflare manages `liverty-music.app`; `dev.liverty-music.app` delegated to Cloud DNS via NS | Cloudflare retains apex authoritative; `api.` + `auth.` subdomains delegated to Cloud DNS via per-subdomain NS records | n/a | ✅ Mutable (Cloudflare API) |
| **Cloud DNS zone count** | 1 zone (`dev.liverty-music.app`) | 2 zones (`api.liverty-music.app`, `auth.liverty-music.app`) | n/a | ❌ Zone names fixed at creation; new zone needs new NS delegation |
| **Certificate Manager hostnames** | `dev.liverty-music.app`, `api.dev.liverty-music.app`, `auth.dev.liverty-music.app` | `api.liverty-music.app`, `auth.liverty-music.app` (no apex cert — Cloudflare serves apex) | n/a | ❌ Certificate `domains` field is immutable; replace requires new cert |
| **API Gateway static IP** | One shared global IP for all dev hostnames | One shared global IP for all prod hostnames | n/a | ✅ Mutable, but Gateway listener pins to it |
| **ArgoCD Applications set** | Full set (argocd / core / external-secrets / reloader / atlas-operator / nats / keda / otel-collector / image-updater / backend / backend-migrations / frontend / gateway / zitadel) | Same full set (parity per resolved Q4 in proposal) | n/a | ✅ Mutable (add or remove yaml files in `argocd-apps/prod/`) |
| **Pulumi deploy trigger** | Auto-deploy on merge to `main` (Pulumi Cloud) | Manual trigger only via Pulumi Cloud console | Per `deployment-infrastructure` spec | ⚠️ Stack-level policy, deliberate |
| **GCP cost guardrails** | Billing budget alert, Places API per-day quota override, Vertex AI per-minute quota override (all dev-only per `gcp-cost-guardrails` spec) | None (avoids over-throttling real prod traffic) | n/a | ✅ Mutable (Pulumi resources) |
| **Places API enablement** | `places.googleapis.com` enabled (used by venue enrichment with the dev quota override gate) | API NOT enabled (env-gated in `kubernetes.ts`) | If prod ever needs venue enrichment | ✅ Mutable (add to API enable list) |
| **Vertex AI / aiplatform.googleapis.com** | Enabled (per `project.ts:112`, unconditional) — used by concert-discovery CronJob with a dev-only per-minute quota override | Enabled (same unconditional API enablement) — no quota override, so workloads in prod are throttled only by the default GCP per-region quotas | n/a — API stays enabled both sides; behavior difference is the quota override only | ✅ Mutable |
| **GitHub Organization-level config** | Skipped (`if (env === 'prod')` gate in `src/index.ts:52`) | Provisioned (org-level GitHub Actions secrets, Buf token, etc.) | n/a | ⚠️ Code gate, deliberate |
| **Cloudflare branch protection (GitHub repos)** | Not applied | Applied (`if (environment === 'prod')` in `src/github/components/repository.ts`) | n/a | ⚠️ Code gate, deliberate |

## Per-namespace Kustomize overlay status

The following table records which Kubernetes namespaces under
`k8s/namespaces/<ns>/overlays/` have a dedicated `prod/` overlay.
Where the base manifest is sufficient for prod, no overlay is needed.

| Namespace | dev overlay | prod overlay | Notes |
|---|---|---|---|
| `argocd` | ✅ | ✅ (pre-existing) | Used by ArgoCD self-management |
| `external-secrets` | ✅ | (audit pending) | Helm-chart based; check helm values per env |
| `reloader` | ✅ | (audit pending) | Single-file overlay; likely env-trivial |
| `atlas-operator` | ✅ | (audit pending) | Helm-based |
| `nats` | ✅ | (audit pending) | StatefulSet; replica counts may differ |
| `keda` | ✅ | (audit pending) | Helm-based |
| `otel-collector` | ✅ | (audit pending) | OTLP exporter endpoint may differ |
| `backend` | ✅ | (audit pending) | Hostnames + ConfigMap values change for prod |
| `frontend` | ✅ | (audit pending) | Hostname changes |
| `zitadel` | ✅ | (deferred) | Awaits Zitadel-for-prod follow-up change |
| `gateway` | ✅ | (audit pending) | HTTPRoute hostnames change |

This table is updated by the `provision-prod-gcp-resources` OpenSpec
change as overlays are authored.

## See also

- [PROD_BOOTSTRAP_DECISIONS.md](./PROD_BOOTSTRAP_DECISIONS.md) — why each decision was made, with future-revisit triggers
- [GKE_CLUSTER_MODE_DECISION.md](./GKE_CLUSTER_MODE_DECISION.md) — Standard vs Autopilot analysis and irreversibility reference
- OpenSpec change `provision-prod-gcp-resources` in `liverty-music/specification` — the change that established this layout
