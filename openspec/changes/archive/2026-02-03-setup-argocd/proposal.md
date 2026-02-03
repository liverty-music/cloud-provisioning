## Why

To enable GitOps-based continuous delivery for the backend application (`backend-app`), we need to establish a dedicated CD pipeline. Setting up ArgoCD in a dedicated namespace provides a robust, standard platform for managing application deployments via Kustomize and Helm, separating infrastructure lifecycle from application lifecycle.

## What Changes

- **Install ArgoCD**: Deploy ArgoCD to a new `argocd` namespace in **ALL** environments (dev, staging, prod).
- **Configure Access**: Expose ArgoCD Web UI via port-forwarding (ClusterIP).
- **GitOps Bootstrap**: Create the "Root Application" (App of Apps) pointing to the `liverty-music/cloud-provisioning` repository.
- **Tooling Choice**: Use Kustomize to manage the ArgoCD installation, leveraging Helm charts.
- **Directory Structure**: Organize manifests by namespace and overlay: `k8s/cluster/namespaces/argocd/{base,overlays}`.
- **Manual Bootstrap**: The initial ArgoCD installation applied manually, followed by applying the Root Application to take over management.

## Capabilities

### New Capabilities

<!-- Capabilities being introduced. Replace <name> with kebab-case identifier (e.g., user-auth, data-export, api-rate-limiting). Each creates specs/<name>/spec.md -->

- `continuous-delivery`: Capabilities related to the CD pipeline, specifically ArgoCD integration and operational requirements.

### Modified Capabilities

<!-- Existing capabilities whose REQUIREMENTS are changing (not just implementation).
     Only list here if spec-level behavior changes. Each needs a delta spec file.
     Use existing spec names from openspec/specs/. Leave empty if no requirement changes. -->

- `deployment-infrastructure`: Update infrastructure specs to include the new dedicated `argocd` namespace and related networking/security requirements for the Web UI.

## Impact

- **Infrastructure**: New `argocd` namespace and resources (Deployments, Services, ConfigMaps, Secrets) in GKE.
- **Networking**: Ingress or LoadBalancer Exposure for ArgoCD UI.
- **Security**: Workload Identity or Service Account adjustments to allow ArgoCD to manage cluster resources.
- **Workflow**: Future application deployments will shift from direct `kubectl`/`pulumi` application to Git-commit-driven workflows via ArgoCD.
