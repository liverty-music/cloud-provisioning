## ADDED Requirements

### Requirement: ArgoCD Notifications controller is enabled
The ArgoCD Helm deployment SHALL have the Notifications controller enabled and running with resource requests and limits configured.

#### Scenario: Notifications controller is running
- **WHEN** ArgoCD is deployed with `notifications.enabled: true`
- **THEN** the `argocd-notifications-controller` Deployment SHALL be created in the `argocd` namespace

#### Scenario: Notifications controller has resource constraints
- **WHEN** the Notifications controller pod is scheduled
- **THEN** it SHALL have CPU and memory requests and limits set to prevent unbounded resource consumption

### Requirement: Google Chat webhook service is configured
The Notifications controller SHALL have a Google Chat service configured using an incoming webhook URL stored in a K8s Secret.

#### Scenario: Service references webhook URL from Secret
- **WHEN** the `argocd-notifications-cm` ConfigMap is rendered
- **THEN** it SHALL contain a `service.googlechat` entry referencing the webhook URL via `$` variable syntax from `argocd-notifications-secret`

#### Scenario: Webhook URL is managed through ESO
- **WHEN** the `argocd-notifications-secret` K8s Secret is needed
- **THEN** it SHALL be created by an ExternalSecret resource that syncs from GCP Secret Manager, not by the Helm chart

### Requirement: Default triggers notify on error conditions
All ArgoCD Applications SHALL receive notifications for sync failures, health degradation, and unknown sync states without requiring per-application annotations.

#### Scenario: Sync failure triggers notification
- **WHEN** an ArgoCD Application's sync operation enters `Error` or `Failed` phase
- **THEN** a notification SHALL be sent to the configured Google Chat space

#### Scenario: Health degradation triggers notification
- **WHEN** an ArgoCD Application's health status becomes `Degraded` (e.g., CrashLoopBackOff, ImagePullBackOff, probe failure)
- **THEN** a notification SHALL be sent to the configured Google Chat space

#### Scenario: Unknown sync status triggers notification
- **WHEN** an ArgoCD Application's sync status becomes `Unknown`
- **THEN** a notification SHALL be sent to the configured Google Chat space

#### Scenario: New applications automatically receive triggers
- **WHEN** a new ArgoCD Application is created
- **THEN** it SHALL receive all default triggers without any additional annotation

### Requirement: ArgoCD secrets are isolated from backend secrets
The ClusterSecretStore used by ArgoCD ExternalSecrets SHALL be separate from the one used by backend and atlas-operator namespaces.

#### Scenario: Dedicated ClusterSecretStore for ArgoCD
- **WHEN** the ArgoCD ExternalSecret references a ClusterSecretStore
- **THEN** it SHALL use a store named `google-secret-manager-argocd` that is restricted to the `argocd` namespace only

#### Scenario: Backend ClusterSecretStore is unchanged
- **WHEN** the existing `google-secret-manager` ClusterSecretStore is evaluated
- **THEN** its conditions SHALL remain restricted to `backend` and `atlas-operator` namespaces only

### Requirement: Webhook URL is stored in Pulumi ESC and GCP Secret Manager
The Google Chat webhook URL SHALL be managed through the Pulumi ESC → GCP Secret Manager pipeline with per-secret IAM bindings.

#### Scenario: Webhook URL is provisioned via Pulumi
- **WHEN** `pulumiConfig.gcp.argocdGoogleChatWebhookUrl` is set in Pulumi ESC
- **THEN** Pulumi SHALL create a `gcp.secretmanager.Secret` named `argocd-google-chat-webhook-url` with the webhook URL as its version data

#### Scenario: Only ESO SA has access to the webhook secret
- **WHEN** the GCP Secret Manager secret for the webhook URL is created
- **THEN** only the ESO service account SHALL have `SecretAccessor` IAM binding on this secret (not the backend-app SA)
