# GKE Autopilot general profile (out-of-band setting)

The prod Autopilot cluster `autopilot-cluster-osaka` runs with the
Autopilot general profile set to `no-performance`. That turns off
proactive capacity provisioning: the pre-provisioned on-demand nodes that
hold only system Pods and `gke-system-balloon-pod`s.

No Pulumi provider can declare this setting yet. `@pulumi/gcp` is generated
from the Terraform Google provider, which does not support it (open
upstream request:
[hashicorp/terraform-provider-google#26958](https://github.com/hashicorp/terraform-provider-google/issues/26958));
`@pulumi/gcp` 9.37 and 10.0.0 have no field for it. So it is applied with
gcloud and recorded here. Pulumi does not read it, so `pulumi up` neither
reverts it nor shows drift.

A `command.local.Command` wrapping the gcloud call was considered and not
adopted. It would not detect drift either; that is the same as this manual
step. Its one real advantage: with the cluster ID in its `triggers`, it
would re-apply the setting automatically when the cluster is re-created,
where this runbook relies on someone remembering to. That advantage is
small here, because the prod cluster has `deletionProtection: true` and
irreversible settings (CMEK, regional Autopilot), so re-creation is not an
expected event. Against it:

- it needs gcloud in the Pulumi Deployments runner, plus the runner's GCP
  OIDC credentials handed to gcloud;
- a `pulumi up` would run a long cluster update that can contend with other
  cluster changes in the same update.

Revisit the choice if the cluster is ever re-created or if upstream support
stays unavailable for long.

OpenSpec change: `optimize-prod-gke-cost` (D6).

## Why

- **Billing:** no change. Under Pod-based billing, nodes and unallocated
  capacity are not billed.
- **Quota:** the balloon-held nodes consume `IN_USE_ADDRESSES` (limit 8),
  `SSD-TOTAL-GB` and `CPUS-ALL-REGIONS`. That quota pressure once blocked
  node upgrades and scale-up.
- **Cost of the change:** general-purpose Pods scale up more slowly when
  no spare node exists.

## Apply

Requires `container.clusters.update` on `liverty-music-prod`.

```bash
gcloud container clusters update autopilot-cluster-osaka \
  --project liverty-music-prod \
  --location asia-northeast2 \
  --autopilot-general-profile=no-performance
```

## Verify

```bash
# The cluster reports the profile
gcloud container clusters describe autopilot-cluster-osaka \
  --project liverty-music-prod --location asia-northeast2 \
  --format=json | jq '.autopilot'

# Within a day, no balloon Pods remain
kubectl get pods -A | grep gke-system-balloon-pod || echo "none"
```

## Revert

```bash
gcloud container clusters update autopilot-cluster-osaka \
  --project liverty-music-prod \
  --location asia-northeast2 \
  --autopilot-general-profile=none
```

If the cluster is ever re-created, apply the setting again. When
hashicorp/terraform-provider-google#26958 ships and `@pulumi/gcp` picks it
up, move the setting into `src/gcp/components/kubernetes.ts` and delete
this runbook.
