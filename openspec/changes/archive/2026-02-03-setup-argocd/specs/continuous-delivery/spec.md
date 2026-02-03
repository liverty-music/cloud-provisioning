## ADDED Requirements

### Requirement: ArgoCD Manifets

The system SHALL provide Kustomize-based manifests for installing ArgoCD.

#### Scenario: Manifest Availability

- **WHEN** checking the `src/k8s` directory
- **THEN** a `argocd` directory exists with a valid `kustomization.yaml`

### Requirement: Internal Web UI Access

The system SHALL provide access to the ArgoCD Web UI via secure internal channels (port-forwarding).

#### Scenario: Port Forward Access

- **WHEN** an administrator establishes a port-forward to the ArgoCD server service
- **THEN** they can access the Web UI on localhost
- **AND** the service is NOT exposed via an external LoadBalancer

### Requirement: Git Repository Integration

The system SHALL be configured to synchronize with the standard project repository.

#### Scenario: Public Repository Connection

- **WHEN** ArgoCD is running
- **THEN** it can successfully fetch manifests from `https://github.com/liverty-music/cloud-provisioning`

### Requirement: Root Application

The system SHALL include a Root Application definition to enable the App-of-Apps pattern.

#### Scenario: Root App Exists

- **WHEN** the setup is complete
- **THEN** an ArgoCD `Application` resource named `root-app` (or similar) exists
- **AND** it is configured to track the `main` branch of the project repository
