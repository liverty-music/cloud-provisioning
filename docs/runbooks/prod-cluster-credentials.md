# Runbook: fetch `kubectl` credentials for the prod GKE cluster

> **Background:** The prod GKE cluster (`autopilot-cluster-osaka` in
> `liverty-music-prod`) is a regional **Autopilot** cluster created by the
> OpenSpec change `migrate-prod-to-autopilot` (which superseded the
> original Standard regional cluster from `provision-prod-gcp-resources`).
> It uses Workload Identity for in-cluster auth and `gke-gcloud-auth-plugin`
> for human `kubectl` access. There is no kubeconfig committed to
> the repo — every operator generates one on demand from gcloud.

## When to use this runbook

Use this when you need to run `kubectl` or `helm` commands against
the prod cluster — typically for:

- Smoke-testing after the first `pulumi up --stack prod`.
- Investigating an alert that requires direct pod / log inspection
  beyond what Cloud Logging shows.
- Manually applying an emergency patch (rare; ArgoCD is authoritative
  for application manifests).

Routine deployments do NOT need this runbook — ArgoCD reconciles
`k8s/argocd-apps/prod/*` automatically.

## Prerequisites

You must have:

- `gcloud` CLI installed and authenticated (`gcloud auth login` for
  human SSO; `gcloud auth application-default login` if using ADC).
- The `gke-gcloud-auth-plugin` component installed:
  ```bash
  gcloud components install gke-gcloud-auth-plugin
  ```
- IAM membership granting at least `roles/container.clusterViewer`
  on `liverty-music-prod`. Read-only operators: `clusterViewer`.
  Write access: `roles/container.developer` or higher (request via
  your usual GCP IAM channel).

## Steps

### 1. Authenticate gcloud against the prod project

```bash
gcloud config set project liverty-music-prod
gcloud auth login
```

If using application-default credentials (ADC) for tooling that
expects them (e.g. some Helm plugins), also run:

```bash
gcloud auth application-default login
```

### 2. Fetch the cluster credentials

```bash
gcloud container clusters get-credentials autopilot-cluster-osaka \
  --region asia-northeast2 \
  --project liverty-music-prod
```

This writes a context entry into `~/.kube/config` named
`gke_liverty-music-prod_asia-northeast2_autopilot-cluster-osaka`
and sets it as the current context.

### 3. Verify the connection

```bash
kubectl config current-context
kubectl get nodes
kubectl get ns
```

Expected:

- The current context shows the prod cluster.
- `kubectl get nodes` returns Autopilot-managed nodes — nodes appear on
  demand as Pods are scheduled, and may show zero nodes when the cluster
  is idle. There is no user-declared node pool to inspect.
- `kubectl get ns` includes the standard namespaces
  (`argocd`, `external-secrets`, `backend`, `frontend`, etc.) once
  ArgoCD has bootstrapped them.

### 4. Switch back to dev when finished

To avoid accidentally running prod-impacting commands later:

```bash
kubectl config use-context gke_liverty-music-dev_asia-northeast2-a_autopilot-cluster-osaka
```

Or use `kubectx prod` / `kubectx dev` if you have
[`kubectx`](https://github.com/ahmetb/kubectx) installed.

## Verifying the irreversible-decision state

After the first `pulumi up --stack prod`, confirm the irreversible
cluster settings from `docs/PROD_BOOTSTRAP_DECISIONS.md` are actually
in effect on the live cluster:

```bash
# Autopilot + Topology + Dataplane V2 + etcd CMEK in one describe
gcloud container clusters describe autopilot-cluster-osaka \
  --region asia-northeast2 \
  --project liverty-music-prod \
  --format='value(autopilot.enabled,location,networkConfig.datapathProvider,databaseEncryption.state,databaseEncryption.keyName)'
```

Expected output:

```
True     asia-northeast2     ADVANCED_DATAPATH     ALL_OBJECTS_ENCRYPTION_ENABLED     projects/liverty-music-prod/locations/asia-northeast2/keyRings/gke-cluster/cryptoKeys/gke-etcd-encryption
```

Notes:
- `autopilot.enabled: True` confirms cluster mode.
- `networkConfig.datapathProvider: ADVANCED_DATAPATH` is implicit on
  Autopilot (set without a Pulumi flag).
- `databaseEncryption.state` returns `ALL_OBJECTS_ENCRYPTION_ENABLED`
  in the API surface even though the Pulumi input is `ENCRYPTED`; this
  is the API's canonical "encrypted" value.

If any value differs from the expected — the cluster was not created
per spec. Do **not** attempt to "fix" it with `gcloud container
clusters update`; per GKE docs none of these settings are mutable
post-creation. Destroy the cluster (`pulumi destroy --target ...`),
correct the Pulumi config, and re-create.

## Troubleshooting

### "gke-gcloud-auth-plugin not found"

```bash
gcloud components install gke-gcloud-auth-plugin
```

Then retry the `get-credentials` command. The Kubernetes client
fork no longer ships in-tree GCP auth as of `client-go` 0.26;
GKE requires the external plugin.

### "Required 'container.clusters.get' permission"

You don't have IAM access. Confirm your `gcloud auth list` shows
the expected identity and that the GCP IAM admin granted at least
`roles/container.clusterViewer` on `liverty-music-prod`.

### `kubectl get nodes` shows no nodes

On Autopilot, nodes are provisioned on demand by Pod scheduling — an
idle cluster (no Pods) will have zero nodes. This is expected. If
Pods are pending and no nodes appear, check Pod scheduling events
(`kubectl describe pod <name>`) for Autopilot policy violations
(privileged container, host network, unsupported resource shape).
Spot Pods specifically may stay pending if Spot capacity is
unavailable in `asia-northeast2`; the Pod event log will say so.

## See also

- [PROD_BOOTSTRAP_DECISIONS.md](../PROD_BOOTSTRAP_DECISIONS.md)
- [GKE_CLUSTER_MODE_DECISION.md](../GKE_CLUSTER_MODE_DECISION.md)
- [DEV_VS_PROD_DIFFERENCES.md](../DEV_VS_PROD_DIFFERENCES.md)
