## Why

The backend application currently lacks a fully automated continuous delivery pipeline to the Kubernetes environment. Establishing this pipeline is essential to enable rapid, reliable, and secure deployment of new features and fixes to production.

## What Changes

- **GitHub Actions Integration**: Enable and configure a GitHub Actions workflow in the backend repository to build and push container images.
- **Artifact Registry Auth**: Configure Workload Identity Federation (WIF) to securely allow GitHub Actions to authenticate with Google Artifact Registry (GAR) without long-lived keys.
- **Kubernetes Manifests**: Create standard Kubernetes manifests (Deployment, Service, ConfigMap) for the `backend` application.
- **GitOps Configuration**: Register the backend application manifests with ArgoCD for automated synchronization.

## Capabilities

### New Capabilities

<!-- Capabilities being introduced. Replace <name> with kebab-case identifier (e.g., user-auth, data-export, api-rate-limiting). Each creates specs/<name>/spec.md -->
<!-- None -->

### Modified Capabilities

<!-- Existing capabilities whose REQUIREMENTS are changing (not just implementation).
     Only list here if spec-level behavior changes. Each needs a delta spec file.
     Use existing spec names from openspec/specs/. Leave empty if no requirement changes. -->

- `continuous-delivery`: Add requirements for backend service delivery, secure CI/CD authentication (WIF), and artifact publishing.

## Impact

- **Repositories**: `liverty-music/backend` (new workflow), `liverty-music/cloud-provisioning` (new manifests, Terraform updates for WIF).
- **Infrastructure**: New Service Account for WIF, IAM bindings for Artifact Registry Writer role.
