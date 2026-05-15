# Revoke cross-project Artifact Registry IAM grant

**Scope**: removing the manual `roles/artifactregistry.reader` grant on `liverty-music-dev` for the prod GKE node service account. Part of OpenSpec change `prepare-prod-service-in` §11.

## Background

During the original prod bring-up (early 2026-Q1), prod GKE pods needed to pull container images, but the prod Artifact Registry had no images yet — only `liverty-music-dev/{backend,frontend}` did. As a one-time stopgap, an operator added a cross-project IAM grant via `gcloud`:

```bash
gcloud projects add-iam-policy-binding liverty-music-dev \
  --member='serviceAccount:gke-node@liverty-music-prod.iam.gserviceaccount.com' \
  --role='roles/artifactregistry.reader'
```

This grant is **not** managed by Pulumi (no corresponding resource in `src/`). It's invisible to `pulumi state` and `pulumi preview`. It allowed prod GKE nodes to pull `liverty-music-dev/*` images.

## When this runbook applies

Run this revocation procedure AFTER all of the following are true:

1. The prod kustomize overlay's `images:` block (per `prepare-prod-service-in` §9) has merged to `cloud-provisioning/main`.
2. ArgoCD has fully reconciled the prod cluster's `backend` and `frontend` Applications. Both report `Synced/Healthy`.
3. Every running Pod in the prod cluster references an image from `asia-northeast2-docker.pkg.dev/liverty-music-prod/*` (NOT `liverty-music-dev/*`). Verify:
   ```bash
   kubectl --context=gke_liverty-music-prod_asia-northeast2_autopilot-cluster-osaka \
     get pods -A -o jsonpath='{range .items[*]}{.spec.containers[*].image}{"\n"}{end}' \
     | grep liverty-music-dev/
   # output MUST be empty
   ```

If any prod Pod still references `liverty-music-dev/*`, **HALT** — revoking the IAM grant will cause those Pods to `ImagePullBackOff` on their next image pull. Investigate the overlay or ArgoCD sync state and fix the source first.

## Revocation procedure

Once the precondition above is satisfied:

```bash
gcloud projects remove-iam-policy-binding liverty-music-dev \
  --member='serviceAccount:gke-node@liverty-music-prod.iam.gserviceaccount.com' \
  --role='roles/artifactregistry.reader'
```

Then wait 5 minutes and verify:

```bash
# Should return empty: no prod-cluster SA on the dev project policy.
gcloud projects get-iam-policy liverty-music-dev \
  --flatten='bindings[].members' \
  --filter='bindings.members~liverty-music-prod'

# Should return empty: no Pod stuck on ImagePullBackOff.
kubectl --context=gke_liverty-music-prod_asia-northeast2_autopilot-cluster-osaka \
  get pods -A | grep -E 'ImagePullBackOff|ErrImagePull'
```

## Recovery

If a Pod hits `ImagePullBackOff` after revocation (= a missed dev-AR reference somewhere), re-add the grant immediately:

```bash
gcloud projects add-iam-policy-binding liverty-music-dev \
  --member='serviceAccount:gke-node@liverty-music-prod.iam.gserviceaccount.com' \
  --role='roles/artifactregistry.reader'
```

Then root-cause the missed reference: typically a sub-base `images:` block that the prod overlay didn't override (see `backend/base/server/kustomization.yaml` etc. for the pre-existing dev-AR pinning in base — the prod overlay must override each of those by name).

## Why this isn't in Pulumi

This grant was a stopgap, not a long-term design. The OpenSpec `prepare-prod-service-in` change makes prod-AR the canonical source so the grant is no longer needed. Reintroducing it as an IaC-managed resource (rather than removing it) would commit us to a cross-project image dependency that violates the `prod-image-pipeline` spec.

If a future change ever requires prod-cluster pulls from dev AR (e.g., shared base images across envs), introduce it via Pulumi `gcp.projects.IAMMember` declared in `cloud-provisioning/src/gcp/`, NOT via manual `gcloud`.
