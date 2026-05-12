# GKE Cluster Mode Decision (Autopilot vs Standard)

Reference document for choosing between GKE Autopilot and Standard for each
environment in Liverty Music. Captures the reasoning so future contributors
don't need to re-derive it.

Last verified against GCP docs: 2026-05-11.

## TL;DR

| Environment | Mode | Topology | Nodes | NAT |
|---|---|---|---|---|
| `dev` | Standard | Zonal (`asia-northeast2-a`) | Public, Spot e2-medium | None |
| `staging` | Autopilot | Regional | Private | Cloud NAT |
| `prod` | **Autopilot** | Regional | Private | Cloud NAT |

`dev` is deliberately the outlier: it trades availability and security for cost.

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
3. **No management-fee arbitrage**: prod is regional → does not qualify for
   the free tier in either mode. Both modes pay $74.40/month on the
   management fee.
4. **Bin-packing**: prod needs HA headroom on Standard nodes (~30-50% idle
   capacity reserve). Autopilot's per-Pod billing eliminates that waste.
5. **Hybrid escape hatch**: as of Sept 2025, per-workload Autopilot ComputeClasses
   work inside Standard clusters and vice versa, so the decision is not
   one-way. See
   <https://cloud.google.com/blog/products/containers-kubernetes/gke-gets-new-pricing-and-capabilities-on-10th-birthday>.

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
