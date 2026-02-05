## ADDED Requirements

### Requirement: Image Build and Publish

The system SHALL automatically build and publish a container image for the backend application when changes are pushed to the main branch.

#### Scenario: Push to Main

- **WHEN** a commit is merged to the `main` branch of `liverty-music/backend`
- **THEN** a GitHub Action triggers the build process
- **AND** a new container image with a unique tag is pushed to the Google Artifact Registry

### Requirement: Secure CI Authentication

The system SHALL utilize Workload Identity Federation (WIF) for authenticating the CI/CD pipeline to Google Cloud services, prohibiting the use of long-lived Service Account keys.

#### Scenario: Action Authentication

- **WHEN** the GitHub Action attempts to authenticate with GCP
- **THEN** it exchanges an OIDC token for a short-lived Google access token via the WIF provider
- **AND** it successfully gains permissions to write to the Artifact Registry

### Requirement: Backend Application Provisioning

The system SHALL include Kubernetes manifests for the backend application that are automatically synced by ArgoCD.

#### Scenario: App Config Exists

- **WHEN** the `cloud-provisioning` repository is inspected
- **THEN** a Kustomize base for the `backend` application exists
- **AND** it is referenced by the ArgoCD Root Application
