# prod Cluster Bootstrap Decisions

Records the decisions made when designing the `liverty-music-prod` GKE cluster
and surrounding infrastructure. Captured so future contributors and security
auditors can trace the rationale.

Last updated: 2026-05-13.

> **Migration history**: the original `provision-prod-gcp-resources` change
> (archived 2026-05-13) created the prod cluster as **Standard regional**. The
> subsequent `migrate-prod-to-autopilot` change (~2026-05) flipped the cluster
> mode to **Autopilot regional** because (i) post-dev-retirement the GKE
> $74.40/mo free-tier credit only covers Autopilot or *zonal* Standard, not
> regional Standard, so Autopilot drops the management fee from $72/mo to $0,
> and (ii) Autopilot's operational simplicity matches the HPA-driven, no-priv-
> DaemonSet workload profile this project ended up with. Decisions §1, §5, §8
> below have been rewritten; the irreversibility table reflects the new state.

Companion documents:
- [GKE_CLUSTER_MODE_DECISION.md](./GKE_CLUSTER_MODE_DECISION.md) — mode choice details, irreversible-vs-reversible reference table.
- [DEV_VS_PROD_DIFFERENCES.md](./DEV_VS_PROD_DIFFERENCES.md) — operator-facing comparison table of every config difference between dev and prod.
- [runbooks/prod-cluster-credentials.md](./runbooks/prod-cluster-credentials.md) — how to fetch kubectl credentials for the prod cluster.
- [runbooks/setup-prod-credentials.md](./runbooks/setup-prod-credentials.md) — generate and register the prod ESC secrets (blockchain EOA, Alchemy RPC + bundler, Postgres admin password, VAPID) before the first `pulumi up --stack prod`.

## Context

- prod has **no users yet** (not yet in service). No SLO obligation in this
  phase.
- Cost is the dominant axis. Availability and security baseline can grow over
  time, but choices that are *irreversible* must be made now.
- Environments are separated at the **GCP project level**
  (`liverty-music-prod` vs `liverty-music-dev`), so VPC / subnet / CIDR can be
  identical without conflict.
- Workload composition matches dev: backend, frontend, Zitadel, ArgoCD, ESO,
  Reloader, Atlas Operator, OTel Collector, NATS, KEDA, Image Updater.
- Blockchain ticket-purchase functionality is planned. Its phase determines
  when external security audit becomes mandatory (see Audit Timing below).

## Decision Summary

| Decision | Value | Reversibility |
|---|---|---|
| Cluster mode | **Autopilot** | Irreversible (re-create + migrate workloads) |
| Cluster topology | Regional (`asia-northeast2`) | Irreversible |
| Network mode | VPC-native (default) | Irreversible |
| Dataplane V2 | ✅ Enabled (Autopilot default, implicit) | Irreversible |
| etcd / Application-layer Secrets CMEK | ✅ Enabled | Irreversible at cluster level |
| Node provisioning | Autopilot-managed (no user-declared NodePool) | N/A — managed by Autopilot |
| Spot scheduling | Per-Pod via `cloud.google.com/gke-spot: "true"` label | Per-workload |
| Boot disk / machine type | Autopilot-managed (no user knob) | N/A |
| Shielded GKE Nodes | Autopilot enforced (no user knob) | N/A |
| Public vs private nodes | Autopilot default network config (no user knob) | N/A |
| Cloud NAT | Not provisioned (no egress workloads yet) | Mutable — add later |
| Cluster-level Confidential GKE Nodes | ❌ Not user-exposed on Autopilot | Per-workload via ComputeClasses (deferred) |
| HSM-protected KMS keys | ❌ Defer to blockchain mainnet phase | Add per-key later |
| GMP / managedPrometheus | ✅ Enabled with cost-control (60s scrape + metric_relabel keep-list) | Required by Autopilot ≥1.25 |
| Logging | Autopilot-managed defaults | Autopilot-managed |
| Service IP secondary range | `10.30.0.0/20` (4,096 services, same as dev) | **Irreversible — cannot expand** |
| Pod IP secondary range | `10.20.0.0/16` (256 nodes max) | Expandable (add more ranges) but not shrinkable |
| Primary subnet range | `10.10.0.0/20` | Expandable, not shrinkable |
| Master IPv4 CIDR | `172.16.0.0/28` | Irreversible |
| Node service account (Autopilot auto-provision) | `gke-node` (per project) | Irreversible |

## Decisions in Detail

### 1. Cluster mode: Autopilot (revised from Standard)

**Why** (revised 2026-05 in `migrate-prod-to-autopilot`):

- **Free-tier math drives it.** The GKE billing-account-wide $74.40/mo credit
  applies to either Autopilot or *zonal* Standard, but not to regional
  Standard. Once dev is retired, prod is the only billable cluster — Autopilot
  ends up at $0/mo management fee, regional Standard at $72/mo.
- **Net savings $50-70/mo (~$600-900/yr)** even after Autopilot's mandatory
  GMP — which cannot be disabled (per
  [GMP setup-managed docs](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/setup-managed):
  *"You can't turn off managed collection in GKE Autopilot clusters running
  GKE version 1.25 or greater"*) — and which we keep in the $5-15/mo band via
  ClusterPodMonitoring metric_relabel + 60s scrape interval (see decision §8).
- **Operational fit.** The workload set (backend, frontend, Zitadel, ArgoCD,
  ESO, Reloader, Atlas, OTel, NATS, KEDA, Image Updater) is HPA-driven and
  uses no privileged DaemonSets, so the Autopilot security/restriction
  envelope is comfortably met.

**Trade-off**: No fine-grained node knob (machine type, disk type, autoscaler
behavior). Spot is now per-Pod (`cloud.google.com/gke-spot: "true"` label).
For dev's aggressive cost optimization (e2-medium + pd-standard 30 GB) we
keep Standard zonal — see `GKE_CLUSTER_MODE_DECISION.md`.

**Reversibility**: NOT in-place mutable in either direction. Switching modes =
create new cluster + workload migration. The migration from Standard to
Autopilot was safe to execute because prod had zero application workloads at
the time of the cutover. Per
[Prepare to migrate to Autopilot from Standard](https://cloud.google.com/kubernetes-engine/docs/how-to/prepare-migrate-cluster-mode):
> "Neither direction supports in-place conversion."

### 2. Topology: Regional (asia-northeast2)

**Why**: Even without SLO, single-AZ failure recovery should not require
manual intervention. With Autopilot, regional clusters are the standard
shape — and they ARE free-tier-eligible under Autopilot mode (the free-tier
exclusion only applies to *regional Standard*, not regional Autopilot).

**Trade-off**: None at the Autopilot tier — regional Autopilot gets the same
$74.40/mo free-tier credit as zonal Autopilot.

**Reversibility**: ❌ Cannot be changed after creation.

### 3. Dataplane V2: Enabled

**Why**: GCP announcement (received 2026-05): Dataplane V2 becomes default on
2027-03-30. Enable now to align with future default and gain:
- NetworkPolicy enforcement always-on
- eBPF-based perf
- Built-in network policy logging
- New GKE features delivered Dataplane-V2-first

**Cost**: None (no premium).

**Reversibility**: ❌ Cannot be enabled or disabled after cluster creation.
> "GKE Dataplane V2 can only be enabled when creating a new cluster.
> Existing clusters cannot be upgraded to use GKE Dataplane V2."
> — [GKE Dataplane V2 docs](https://cloud.google.com/kubernetes-engine/docs/concepts/dataplane-v2)

### 4. etcd / Application-layer Secrets CMEK: Enabled

**Why**: Future SOC2 / blockchain security audit will almost certainly
require encryption-at-rest with customer-controlled keys for Kubernetes
Secret resources. Enabling later requires cluster-wide operation; cost is
negligible ($0.06/month for one software key + ops within free tier).

**What it encrypts**: Kubernetes Secret resources written to etcd (not
control-plane disks themselves — those cannot be CMEK-protected).

**What it does NOT encrypt**: Boot disks (separate setting), Persistent
Volumes (StorageClass setting), in-memory secrets (Confidential Nodes
needed).

**Cost**:
- Software key: $0.06 / key version / month
- Symmetric encrypt/decrypt: $0.03 / 10k operations
- 20,000 operations / month free tier per project
- Estimated total: ~$0.20/month (¥30/month)

**Reversibility**: Set at cluster creation. Can rotate to a new key, but
enabling it on an existing cluster requires a cluster-wide re-encryption
operation.

**Implementation note**: Will need a new Cloud KMS keyring + key under the
prod project. Configure via Pulumi `databaseEncryption` field on
`gcp.container.Cluster`.

### 5. Public-vs-private nodes: Autopilot default (revised from explicit `enablePrivateNodes: false`)

**Why**: On Autopilot, public-vs-private node configuration is not a
user-exposed cluster-level toggle the way it is on Standard — Autopilot
applies its default network configuration. The original Standard decision
explicitly set `enablePrivateNodes: false` to avoid Cloud NAT cost; under
Autopilot, the equivalent intent (no Cloud NAT, no egress workload yet) is
preserved by simply not provisioning Cloud NAT.

**Future revisit trigger**: First real users / external traffic.
If outbound egress (e.g., calls to external APIs from prod Pods) becomes
required, provision Cloud NAT (and, if Autopilot is operating in
private-nodes mode, ensure egress flows through it).

### 6. Confidential GKE Nodes (cluster level): Skip

**Why**:
- Cluster-level Confidential Nodes are **not user-exposed on Autopilot**.
  The Autopilot equivalent (Confidential workloads) is requested per-workload
  via ComputeClasses, not cluster-wide.
- Does NOT solve the blockchain-key-protection problem (a compromised
  container can still read its own memory). KMS-based signing is the right
  abstraction for that.

**Future revisit trigger**: Blockchain mainnet GA — at that point, request
Confidential compute per-workload via Autopilot ComputeClasses for the
signing path. Until then, the cluster-level intent of "no cluster-wide
Confidential Nodes" is preserved by default.

### 7. CIDR ranges: same as dev

**Why**: GCP project separation means VPCs are independent — no IP conflict.
Mental model overhead minimized by sharing one `NetworkConfig.Osaka` constant
([src/gcp/index.ts:39-50](../src/gcp/index.ts#L39-L50)).

Current sizing supports up to 256 nodes (Pod range `/16`) and 4,096 services
(`/20`). Well beyond expected prod scale for the foreseeable future.

**Irreversibility focus**: The Service secondary range
(`servicesCidr: 10.30.0.0/20`) **cannot be expanded or changed** after
cluster creation. `/20` = 4,096 services is generous and accepted.

The Pod range can be expanded by adding additional Pod IP ranges
(discontiguous CIDR) if scale ever exceeds 256 nodes.

### 8. Workload set: GMP enabled with cost-control, Spot via per-Pod label

**Why** (revised 2026-05 in `migrate-prod-to-autopilot`):

- **GMP is now mandatory** under Autopilot ≥1.25 (cannot be disabled per
  [GMP setup-managed docs](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/setup-managed)).
  We accept the cost and keep it in the $5-15/mo band via a
  ClusterPodMonitoring resource that:
  - Restricts ingested metrics to an allow-list (`kube_(node|deployment|pod|namespace|statefulset|daemonset)_.+`
    and `container_(cpu|memory)_.+`) using `metric_relabeling` keep rules.
  - Uses `interval: 60s` instead of the default 15s (4× reduction).
  - Leaves automatic application monitoring off; workload metrics are opt-in
    via per-namespace PodMonitoring CRDs.
- **Spot scheduling is per-Pod** on Autopilot (no node pool to declare).
  Workloads that tolerate preemption already use the
  `cloud.google.com/gke-spot: "true"` nodeSelector (same convention dev uses);
  Autopilot honors it and bills the Pod at Spot Pod rates.
- **Logging** falls back to Autopilot's defaults — Autopilot exposes fewer
  knobs than Standard. The cluster's default logging behavior is accepted.

**Future revisit trigger**: Going live with users. At that point, expect to:
- Add per-namespace PodMonitoring CRDs for the application metrics that need
  active alerting.
- Relax the GMP cost-control rules selectively as alert coverage grows
  (still cheaper than the unfiltered default).
- Add a non-Spot ComputeClass workload preference for latency-sensitive Pods
  (background / batch stay on Spot).

## Future Revisit Triggers

| Trigger | Decisions to revisit |
|---|---|
| First real users on prod | `enablePrivateNodes`, Cloud NAT, GMP, non-Spot pool for critical workloads, replicas + HPA |
| Blockchain testnet → mainnet beta | KMS-based key signing (move blockchain keys from Secret Manager → Cloud KMS sign API), SA split (deployer vs signer), audit logging review |
| Blockchain mainnet GA | External infra security audit, smart contract audit (CertiK / OpenZeppelin / Halborn), Confidential Nodes on dedicated signing node pool, Cloud HSM keys |
| SOC2 Type II consideration | Boot disk CMEK on new pools, formal key rotation policy, audit-trail completeness review |
| Multi-region DR requirement | Second cluster (different region), Multi-Cluster Ingress / Global LB |

## Audit Timing Guidance for Blockchain Feature

| Blockchain phase | Audit posture |
|---|---|
| Internal testnet | None — no funds at risk |
| Mainnet beta (limited users, transaction caps) | Internal security review. Move signing keys to Cloud KMS. SA split. Audit logging in place. |
| Mainnet GA (open, no caps) | External infra audit + smart contract audit mandatory |
| Enterprise customers / B2B | SOC2 Type II initiation |

## Key Security Principle: Private Key Storage

**Blockchain private keys (deployer, signer, treasury) must NOT live in
container memory as plain environment variables.** Current state has them
in GCP Secret Manager → flowed via ESO → Kubernetes Secret → env var, which
exposes them in container memory and is the first thing an auditor will
flag.

The target pattern is:
- Key material stored in Cloud KMS (asymmetric signing keys).
- Application calls KMS `AsymmetricSign` API with the key resource name and
  message digest.
- Signature is returned; the private key never leaves KMS.
- Workload Identity binds the signing K8s ServiceAccount to a dedicated GCP
  SA with `roles/cloudkms.signer` on only that key.

This eliminates entire classes of attack (memory dump, core dump, log
leakage) that Confidential Nodes can only partially mitigate.

## Implementation Reference

Prod cluster is implemented in
[`src/gcp/components/kubernetes.ts`](../src/gcp/components/kubernetes.ts) as
the `environment === 'prod'` branch. Key shape:

- `enableAutopilot: true`
- `location: ${region}` (regional, not `${region}-a`)
- `databaseEncryption: { state: 'ENCRYPTED', keyName: <KMS key> }`
- `ipAllocationPolicy` with `pods-range` / `services-range` secondary names
- `clusterAutoscaling.autoProvisioningDefaults.serviceAccount: gke-node` SA
- `workloadIdentityConfig.workloadPool: ${projectId}.svc.id.goog`
- `gatewayApiConfig.channel: CHANNEL_STANDARD`
- `costManagementConfig.enabled: true`
- `releaseChannel.channel: REGULAR`
- `deletionProtection: true`

Dataplane V2, Shielded GKE Nodes, GMP, and node provisioning are
Autopilot-managed — no explicit flags. GMP cost-control lives in
[`k8s/cluster/overlays/prod/cluster-pod-monitoring.yaml`](../k8s/cluster/overlays/prod/cluster-pod-monitoring.yaml).

Cloud KMS resources (unchanged from the original Standard cluster, reused by
the Autopilot cluster):
  - KeyRing `gke-cluster`
  - CryptoKey `gke-etcd-encryption` (PURPOSE_ENCRYPT_DECRYPT, software)
  - IAM binding: GKE service agent → `roles/cloudkms.cryptoKeyEncrypterDecrypter`

## Sources

- [Prepare to migrate to Autopilot from Standard (mode is not in-place mutable)](https://cloud.google.com/kubernetes-engine/docs/how-to/prepare-migrate-cluster-mode)
- [GKE Dataplane V2 (creation-time only)](https://cloud.google.com/kubernetes-engine/docs/concepts/dataplane-v2)
- [GKE Network Isolation (private nodes are mutable)](https://cloud.google.com/kubernetes-engine/docs/concepts/network-isolation)
- [GKE types of clusters (immutable fields)](https://cloud.google.com/kubernetes-engine/docs/concepts/types-of-clusters)
- [Alias IPs and ipAllocationPolicy sizing](https://cloud.google.com/kubernetes-engine/docs/concepts/alias-ips)
- [Confidential GKE Nodes (cluster-level setting is irreversible)](https://cloud.google.com/kubernetes-engine/docs/how-to/confidential-gke-nodes)
- [Confidential VM pricing](https://cloud.google.com/confidential-computing/confidential-vm/pricing)
- [Cloud KMS pricing](https://cloud.google.com/kms/pricing)
- [GKE pricing (cluster management fee, free tier)](https://cloud.google.com/kubernetes-engine/pricing)
- [GKE 10th birthday pricing announcement (Sept 2025 single paid tier)](https://cloud.google.com/blog/products/containers-kubernetes/gke-gets-new-pricing-and-capabilities-on-10th-birthday)
