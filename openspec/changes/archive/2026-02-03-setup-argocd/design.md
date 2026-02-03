## Context

The project is adopting GitOps. We use a **Decoupled** approach where Pulumi manages GKE, and ArgoCD manages Kubernetes workloads. We have adopted an **App-of-Apps** pattern for scalability.

## Goals

- **Directory Structure**:
  - `k8s/argocd-apps`: Contains ArgoCD `Application` definitions ("App of Apps" layer).
  - `k8s/cluster`: Contains global cluster config (e.g., `namespaces.yaml`).
  - `k8s/namespaces`: Contains actual workload manifests (e.g., `argocd/`, `backend/`).
- **GitOps Bootstrap**: `root-app.yaml` points to `k8s/argocd-apps/dev`, which then deploys the rest.

## Decisions

### 1. Directory Structure

- **Decision**: Use `k8s/argocd-apps` for meta-apps and `k8s/namespaces` for manifests.
- **Rationale**: Clear separation between "What to deploy" (apps) and "How to configure it" (manifests).

### 2. GitOps Flow

1. Manual Apply: `k8s/namespaces/argocd/overlays/dev` (Bootstrap ArgoCD itself).
2. Manual Apply: `k8s/namespaces/argocd/base/root-app.yaml`.
3. Auto Sync: `root-app` -> `k8s/argocd-apps/dev` -> [`argocd.yaml`, `cluster.yaml`].

## Components

- **root-app**: The bootstrap application that points to the `argocd-apps` directory.
- **argocd-app**: Manages the ArgoCD installation itself (self-management).
- **cluster-app (cluster.yaml)**: Manages cluster-wide resources like namespaces.
