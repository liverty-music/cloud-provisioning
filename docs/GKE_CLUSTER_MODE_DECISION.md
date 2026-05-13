# GKE Cluster Mode Decision (Autopilot vs Standard)

Reference document for choosing between GKE Autopilot and Standard for each
environment in Liverty Music. Captures the reasoning so future contributors
don't need to re-derive it.

Last verified against GCP docs: 2026-05-13.

## TL;DR

| Environment | Mode | Topology | Nodes | NAT |
|---|---|---|---|---|
| `dev` | Standard | Zonal (`asia-northeast2-a`) | Public, Spot e2-medium | None |
| `staging` | Autopilot | Regional | Private | Cloud NAT |
| `prod` | **Autopilot** (revised from Standard) | Regional | Autopilot-managed | Not provisioned (cost-first) |

`dev` is deliberately the outlier: it trades availability and security for cost.
`prod` was initially Standard regional and was migrated to Autopilot regional
in `migrate-prod-to-autopilot` (~2026-05) once the free-tier math became clear
post-dev-retirement plan — see "Why we revised the prod decision" below.

## Pricing facts (verified May 2026)

Source: <https://cloud.google.com/kubernetes-engine/pricing>

1. **Cluster management fee = $0.10/hour for every cluster**, irrespective of
   mode (Autopilot or Standard), topology (zonal or regional), or size. Quote:
   > "A flat cluster management fee of $0.10 per cluster per hour ... applies
   > to all GKE clusters irrespective of the mode of operation, cluster size,
   > or topology."

2. **GKE free tier = $74.40 monthly credit per billing account**, applied to
   "zonal Standard or Autopilot clusters". Regional Standard clusters are
   **not** covered.

3. **Compute billing differs by mode**:
   - **Autopilot**: pay only for Pod resource requests (CPU / memory / Spot /
     accelerator class).
   - **Standard**: pay for node VMs, regardless of how full the Pods pack
     them.

4. **Cost claim by Google** (blog, May 2026): Autopilot can save up to 85%
   TCO vs traditional managed Kubernetes; benchmarks of ~12% and ~42%
   savings on real workloads. Per-unit price is higher than VM pricing, but
   you stop paying for unused node headroom and the OS overhead.

## Why dev uses Standard

Standard mode is a **deliberate exception** for dev only, justified by:

- Spot e2-medium nodes (~70% cheaper than on-demand). Autopilot supports Spot
  but with less node-pool granularity.
- 30 GB `pd-standard` boot disks (default is 100 GB `pd-balanced`).
- kube-dns autoscaler override (drop replicas 2 → 1) to free CPU for the
  cluster autoscaler to retire the 3rd node.
- GMP disabled (dev has no metric-based alerts).
- Public nodes (no Cloud NAT, saves ~¥5,292/month).
- Zonal (free-tier credit applies to either Autopilot or zonal Standard, so
  this part is **mode-neutral**; the choice was driven by Compute Engine
  control, not the management fee).

**Tradeoff**: dev is single-zone and has public node IPs. Both are
unacceptable for prod.

## Why staging and prod use Autopilot

Google's explicit guidance, from
<https://cloud.google.com/kubernetes-engine/docs/concepts/choose-cluster-mode>:

> "Use Autopilot for most workloads, unless your application requires
> privileges or configuration options that don't meet the Autopilot
> constraints."
>
> "Autopilot ... Ideal for most production workloads."

Specific reasons for Liverty Music prod:

1. **Workload fit**: Zitadel, backend API, frontend, ArgoCD, ESO, Reloader
   are all general-purpose HPA-driven services. No DaemonSets requiring host
   privileges, no GPU/accelerator demand, no CPU pinning needs.
2. **Operational savings**: small team. Node pool sizing, autoscaler tuning,
   GKE version upgrades, disk type/size decisions are non-revenue work.
3. **Free-tier covers Autopilot management fee**: regional Autopilot IS
   free-tier-eligible (only *regional Standard* is excluded). With dev
   retired, prod's $72/mo management fee is fully offset by the $74.40/mo
   billing-account credit, dropping it to $0.
4. **Bin-packing**: prod needs HA headroom on Standard nodes (~30-50% idle
   capacity reserve). Autopilot's per-Pod billing eliminates that waste.
5. **Hybrid escape hatch**: as of Sept 2025, per-workload Autopilot ComputeClasses
   work inside Standard clusters and vice versa, so the decision is not
   one-way. See
   <https://cloud.google.com/blog/products/containers-kubernetes/gke-gets-new-pricing-and-capabilities-on-10th-birthday>.

## Why we revised the prod decision (2026-05)

The original `provision-prod-gcp-resources` change picked **Standard regional**
on the rationale that node-level control (Spot e2-medium, pd-standard 30 GB,
GMP disabled) would carry over from dev. After provisioning prod and looking
at the billing impact, two facts reshaped the decision:

1. **Free-tier math**. The GKE $74.40/mo billing-account-wide credit applies
   to Autopilot (zonal or regional) OR *zonal* Standard, but NOT to regional
   Standard. As soon as dev is retired (planned post-launch), prod becomes
   the only billable cluster — Autopilot pays $0/mo management fee, regional
   Standard pays $72/mo. Net annual delta: ~$864 of pure waste.

2. **GMP cost is bounded, not free**. GMP managed collection cannot be
   disabled on Autopilot ≥1.25 per
   [GMP setup-managed docs](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/setup-managed):
   *"You can't turn off managed collection in GKE Autopilot clusters running
   GKE version 1.25 or greater"*. Empirically a stock dev Autopilot once cost
   "a few thousand yen" in unfiltered GMP ingestion. The lever to bound this
   is the cluster's
   `monitoringConfig.managedPrometheus.autoMonitoringConfig.scope: 'NONE'`
   flag, which disables Autopilot's auto-discovery of application Pods. The
   GKE-managed system pipeline (kubelet, cAdvisor, kube-state-metrics) is
   the unavoidable cost floor. Target band for an idle / light prod cluster:
   `$5-15/mo`, well inside the savings envelope. (Note: a user
   `ClusterPodMonitoring` with `metric_relabeling` keep-rules does NOT
   filter the managed-collection system pipeline — its relabel rules only
   apply to metrics it scrapes itself. That mechanism was floated in the
   first draft of `migrate-prod-to-autopilot` but rejected during PR review.)

Net post-migration math: Standard regional was $77.76/mo (management + Spot
compute); Autopilot regional is $5-22/mo (GMP + Pod-level Spot). Savings:
$55-72/mo, ~$660-864/yr.

The decision to migrate was made safely because prod had **zero application
workloads** at the time — the destroy-and-recreate operation has no live-user
blast radius.

## When to revisit (prod)

Switch prod from Autopilot → Standard if **and only if** one of these is
true:

1. Need Spot in prod (cost-driven HA trade — not typical for prod).
2. Need DaemonSets requiring host privileges (e.g., custom CNI, node-local
   cache).
3. Need bare-metal performance tuning (CPU pinning, hugepages, NUMA).
4. Locked into a specific feature Autopilot doesn't support — see
   <https://cloud.google.com/kubernetes-engine/docs/resources/autopilot-standard-feature-comparison>.

## Irreversible vs reversible cluster settings

This shapes the prod provisioning order. Verified against
<https://cloud.google.com/kubernetes-engine/docs/concepts/types-of-clusters>
and the network-isolation concepts page.

### Immutable after creation — must be right on day 1

- Cluster availability type (zonal vs regional)
- Region location
- Network and subnet assignment
- Network routing mode (VPC-native vs routes-based)
- Pod and Service secondary IP ranges
- Node service account

### Mutable after creation — can be deferred or changed later

- `enablePrivateNodes` (public ↔ private node toggle). Per GKE
  network-isolation docs: *"You can change these settings at any time."*
- `enablePrivateEndpoint` (private vs public control plane endpoint)
- Master authorized networks
- Cloud NAT (this is a VPC-level resource, not a cluster setting; add or
  remove any time)
- Release channel
- Logging / monitoring components
- Add-on toggles
- Node pool size, machine type, disk size (create new pool, drain old)
- HPA settings, Pod resource requests

### Implication for prod provisioning order

Pick zonal-vs-regional, region, VPC/subnet, secondary ranges, routing
mode, and node SA **first** — these are forever. Layer security (private
nodes, NAT, authorized networks) and right-sizing on top — those can be
tuned over time.

## See also

- <https://cloud.google.com/kubernetes-engine/pricing>
- <https://cloud.google.com/kubernetes-engine/docs/concepts/choose-cluster-mode>
- <https://cloud.google.com/kubernetes-engine/docs/resources/autopilot-standard-feature-comparison>
- <https://cloud.google.com/blog/products/containers-kubernetes/how-gke-autopilot-saves-on-kubernetes-costs>
