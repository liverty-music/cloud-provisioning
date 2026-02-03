## Context

The backend application source code resides in `github.com/liverty-music/backend`. The infrastructure is managed in `github.com/liverty-music/cloud-provisioning`. Currently, there is no automated bridge between code changes in the backend repo and deployment in the Kubernetes cluster. We need to implement the standard CI/CD bridge.

## Goals / Non-Goals

**Goals:**

- Enable `git push` to `main` on backend repo to trigger an image build and push.
- Securely authenticate GitHub Actions to Google Artifact Registry using Workload Identity Federation (WIF).
- Define Kubernetes Deployment, Service, and Ingress/ConfigMap for the backend.
- Ensure ArgoCD automatically syncs new manifests.

**Non-Goals:**

- Setting up creating a new GKE cluster (assumed existing).
- Database migrations (handled separately or in a future change).
- Complex canary deployments (start with RollingUpdate).

## Decisions

### 1. Workload Identity Federation (WIF)

**Decision:** Use GCP Workload Identity Federation for GitHub Actions authentication.
**Rationale:** Eliminates the need for long-lived Service Account JSON keys, reducing security risks and management overhead (key rotation). It is the recommended best practice for CI/CD auth.

### 2. Kustomize for Kubernetes Manifests

**Decision:** Use Kustomize to manage backend application manifests.
**Rationale:** aligns with the existing pattern in `cloud-provisioning` repo (e.g., for `argocd` setup). Allows for cleaner base/overlay structure if we add staging/prod environments later.

### 3. ArgoCD App-of-Apps Integration

**Decision:** Add the backend application directly to the set of applications managed by the existing Root App.
**Rationale:** Keeps the delivery structure centralized and discoverable.

## Risks / Trade-offs

- **WIF Complexity:** Setting up WIF involves correct IAM binding and attribute mapping.
  - _Mitigation:_ Use verified Terraform modules or standard gcloud commands for setup; double-check the `sub` claim formatting (repo:owner/repo:ref:refs/heads/main).
- **Image Tag Immutability:** Using `latest` tag is an anti-pattern.
  - _Mitigation:_ The CI pipeline should push a unique tag (SHA or timestamp) and update the Kustomize image tag. For this initial setup, we may start with a static tag or `latest` for simplicity, but goal is unique tags. _Decision_: Use Commit SHA as tag.
