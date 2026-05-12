# prod Cluster Bootstrap Decisions

Records the decisions made when designing the `liverty-music-prod` GKE cluster
and surrounding infrastructure. Captured so future contributors and security
auditors can trace the rationale.

Last updated: 2026-05-11.

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
| Cluster mode | Standard | Irreversible (re-create + migrate workloads) |
| Cluster topology | Regional (`asia-northeast2`) | Irreversible |
| Network mode | VPC-native (default) | Irreversible |
| Dataplane V2 | ✅ Enabled (`datapathProvider: 'ADVANCED_DATAPATH'`) | Irreversible |
| etcd / Application-layer Secrets CMEK | ✅ Enabled | Irreversible at cluster level |
| `enablePrivateNodes` | `false` (public nodes, no Cloud NAT) | Mutable — flip later |
| Cloud NAT | Not provisioned | Mutable — add later |
| Node pool: machine type | e2-medium Spot (same as dev) | Replaceable (new pool) |
| Node pool: max nodes | 3 (same as dev initially) | Mutable — config value |
| Boot disk | 30 GB pd-standard | Replaceable (new pool) |
| Boot disk CMEK | ❌ Default Google encryption | Per-pool replaceable |
| Cluster-level Confidential GKE Nodes | ❌ Skip | Irreversible (set if "yes") |
| Node-pool Confidential Nodes | ❌ Skip initially, add for blockchain signing pool | Pool-level — add later OK |
| HSM-protected KMS keys | ❌ Defer to blockchain mainnet phase | Add per-key later |
| GMP / managedPrometheus | Disabled (same as dev) | Mutable |
| Logging components | `SYSTEM_COMPONENTS` + `WORKLOADS` | Mutable |
| Service IP secondary range | `10.30.0.0/20` (4,096 services, same as dev) | **Irreversible — cannot expand** |
| Pod IP secondary range | `10.20.0.0/16` (256 nodes max) | Expandable (add more ranges) but not shrinkable |
| Primary subnet range | `10.10.0.0/20` | Expandable, not shrinkable |
| Master IPv4 CIDR | `172.16.0.0/28` | Irreversible |
| Node service account | `gke-node` (per project) | Irreversible |

## Decisions in Detail

### 1. Cluster mode: Standard (not Autopilot)

**Why**: User-chosen for consistency with dev. Standard offers fine-grained
node-pool control (Spot, machine type, disk type) that we exercised in dev to
hit ~50% cost reduction. Same mental model across envs.

**Trade-off**: Google's official recommendation is "Autopilot for most
production workloads". Once prod has users and operational toil becomes
expensive, revisit.

**Reversibility**: NOT in-place mutable. Switching modes = create new cluster
+ workload migration. Per [Prepare to migrate to Autopilot from Standard](https://cloud.google.com/kubernetes-engine/docs/how-to/prepare-migrate-cluster-mode):
> "Neither direction supports in-place conversion."

### 2. Topology: Regional (asia-northeast2)

**Why**: Even without SLO, single-AZ failure recovery should not require
manual intervention. Free-tier credit eligibility is identical for regional
Standard vs zonal (in fact, regional Standard does **not** qualify for free
tier; only zonal Standard and Autopilot do). Net additional cost:
$0.10/hr × 24 × 30 = $72/month management fee (uncovered by free tier).

**Trade-off**: ~¥10,800/month extra vs zonal. Accepted because the
zonal → regional migration is irreversible.

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

### 5. enablePrivateNodes: false (public nodes), no Cloud NAT

**Why**: Cost-first phase, no users. Mirrors dev — saves ~¥5,292/month on
Cloud NAT fixed cost. Acceptable because **this setting is mutable**:
> "You can change these settings at any time."
> — [Network isolation docs](https://cloud.google.com/kubernetes-engine/docs/concepts/network-isolation)

**Future revisit trigger**: First real users / external traffic.
Flip `enablePrivateNodes` → `true` and add Cloud NAT in the same Pulumi
update. Workloads continue running.

### 6. Confidential GKE Nodes (cluster level): Skip

**Why**:
- Cluster-level enablement is **irreversible**.
- Forces machine family from e2 → N2D / C3, raising node cost ~4-5x at the
  smallest size before the Confidential premium itself.
- Does NOT solve the blockchain-key-protection problem (a compromised
  container can still read its own memory). KMS-based signing is the right
  abstraction for that.
- Node-pool-level Confidential Nodes can be added later as a dedicated
  blockchain-signing node pool (taint-isolated).

**Future revisit trigger**: Blockchain mainnet GA, or auditor explicitly
requires it.

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

### 8. Workload set: same as dev (GMP, Spot, etc.)

**Why**: No users → no alerting need → GMP off, logging minimal.
Spot VMs acceptable because preemption only affects internal dogfooding,
not external SLO. Same `cloud.google.com/gke-spot: "true"` nodeSelector
in workload manifests works unchanged.

**Future revisit trigger**: Going live with users. At that point, expect to:
- Enable GMP (`managedPrometheus.enabled: true`)
- Add `WORKLOADS` log streaming (already on after [e72720f](https://github.com/liverty-music/cloud-provisioning/commit/e72720f))
- Add a non-Spot node pool for latency-sensitive workloads, retain Spot for
  background / batch.

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

## Implementation Sketch (not yet coded)

The following Pulumi changes are NOT yet implemented. They are the planned
shape of the prod cluster definition derived from the decisions above.

```typescript
// In kubernetes.ts, replace the `if (environment === 'prod') return;` block
// with a Standard-mode cluster definition mirroring dev but with:
//   • location: `${region}`           (regional, not `${region}-a`)
//   • datapathProvider: 'ADVANCED_DATAPATH'   (Dataplane V2)
//   • databaseEncryption: { state: 'ENCRYPTED', keyName: <prod KMS key> }
//   • enablePrivateNodes: false      (mutable, defer until users arrive)
//   • node pool: identical to dev (e2-medium Spot, 30 GB pd-standard)
//
// New Cloud KMS resources needed in prod project:
//   • KeyRing 'gke-cluster'
//   • CryptoKey 'gke-etcd-encryption' (PURPOSE_ENCRYPT_DECRYPT, software)
//   • IAM binding: GKE service agent → roles/cloudkms.cryptoKeyEncrypterDecrypter
```

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
