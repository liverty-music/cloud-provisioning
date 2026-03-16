## Context

ArgoCD manages 10 Applications via the App of Apps pattern with automated sync and self-heal. The ArgoCD Helm chart (argo-cd 9.4.0) includes a Notifications controller that is currently disabled (`notifications.enabled: false`). Secrets are managed through Pulumi ESC → GCP Secret Manager → ESO (ExternalSecret Operator) → K8s Secret. The existing ClusterSecretStore restricts access to `backend` and `atlas-operator` namespaces only.

## Goals / Non-Goals

**Goals:**
- Enable ArgoCD Notifications controller with Google Chat as the notification service
- Alert on sync failures, health degradation, and unknown sync states for all ArgoCD Applications
- Maintain secret permission isolation between backend and ArgoCD namespaces
- Manage the Google Chat webhook URL through the existing Pulumi ESC → GCP Secret Manager → ESO pipeline

**Non-Goals:**
- GCP Cloud Monitoring-based K8s event alerts (CrashLoopBackOff detail, Node conditions) — future work
- Success/deploy notifications (on-deployed, on-sync-succeeded) — can be added later
- Per-application notification customization — all apps get the same triggers via defaultTriggers
- Custom notification templates with cardsV2 format — start with the built-in catalog templates

## Decisions

### D1: Dedicated ClusterSecretStore for ArgoCD namespace

**Decision**: Create a new `ClusterSecretStore` (`google-secret-manager-argocd`) restricted to the `argocd` namespace, rather than adding `argocd` to the existing store's conditions.

**Alternatives considered**:
- Add `argocd` to existing ClusterSecretStore conditions — simpler but grants ArgoCD namespace ExternalSecrets access to the same GCP Secret Manager project as backend secrets. The ESO SA would be shared, meaning ArgoCD ExternalSecrets could potentially reference backend secret keys.
- Namespace-scoped SecretStore in ArgoCD — requires a separate GCP SA with WIF binding, more infrastructure overhead.

**Rationale**: A dedicated ClusterSecretStore uses the same ESO SA (which already has per-secret IAM bindings) but limits which namespaces can reference it. Combined with per-secret IAM on the GCP side, this provides defense-in-depth: even if the ClusterSecretStore allows argocd namespace, the ESO SA can only access secrets it has explicit IAM bindings for.

### D2: Webhook URL managed through ESC → GCP Secret Manager → ESO

**Decision**: Follow the existing secret management pattern:
1. Store webhook URL in Pulumi ESC (`pulumiConfig.gcp.argocdGoogleChatWebhookUrl`)
2. Pulumi creates a `gcp.secretmanager.Secret` with per-secret IAM binding for the ESO SA only (not backend-app SA)
3. An `ExternalSecret` in argocd namespace syncs to a K8s Secret named `argocd-notifications-secret`
4. ArgoCD Notifications controller references the secret key via `$` syntax in the service config

**Rationale**: Consistent with the existing atlas-db-credentials and backend-secrets patterns. The webhook URL is a credential (contains auth token) and should not be stored in Git.

### D3: Helm values.yaml for notifications configuration

**Decision**: Configure triggers, templates, and service definitions directly in the ArgoCD Helm `values.yaml`, following the existing pattern where all ArgoCD config lives in this file.

**Alternatives considered**:
- Separate Kustomize patches for notifications-cm — adds complexity with no benefit since the Helm chart natively supports notifications config via values
- Per-overlay values files — unnecessary since triggers and templates are environment-agnostic (only the webhook URL differs, and that's in the Secret)

**Rationale**: The existing values.yaml already contains all ArgoCD configuration (server, controller, redis, etc.). Adding notifications config here maintains consistency. The Helm chart renders `argocd-notifications-cm` ConfigMap from these values.

### D4: Use Helm `secret.create: false` with ESO-managed Secret

**Decision**: Disable Helm-managed secret creation (`notifications.secret.create: false`) and let ESO create the `argocd-notifications-secret` K8s Secret instead.

**Rationale**: The ArgoCD Notifications controller expects a Secret named `argocd-notifications-secret` in the `argocd` namespace. By default, the Helm chart creates this Secret. Since we manage credentials through ESO, we disable Helm secret creation and let the ExternalSecret resource own this Secret. This avoids conflicts between Helm and ESO managing the same resource.

### D5: Use built-in catalog triggers with defaultTriggers

**Decision**: Install the built-in trigger/template catalog and use `defaultTriggers` to apply `on-sync-failed`, `on-health-degraded`, and `on-sync-status-unknown` to all Applications without individual annotations.

**Rationale**: defaultTriggers eliminates the need to annotate each of the 10 ArgoCD Applications individually. New Applications automatically inherit the triggers. Individual apps can opt out via annotation if needed.

## Risks / Trade-offs

**[ArgoCD health detection delay]** ArgoCD takes ~10 minutes to mark an application as Degraded after a pod becomes unhealthy.
→ Acceptable for now. GCP Cloud Monitoring log-based alerts can be added later for faster, granular detection.

**[Notification noise from self-heal loops]** Applications with `selfHeal: true` may trigger transient Degraded/Unknown states during auto-repair.
→ The `on-health-degraded` trigger fires once per state change, not continuously. If noise becomes an issue, `oncePer` can be added to debounce.

**[Webhook URL rotation]** Rotating the Google Chat webhook URL requires updating Pulumi ESC, running `pulumi up` to update GCP Secret Manager, then waiting for ESO refresh (1h default) or manually triggering a sync.
→ Acceptable. Webhook URLs rarely rotate. ESO refresh interval can be decreased if needed.

**[Helm chart upgrade compatibility]** Future ArgoCD Helm chart upgrades may change the notifications values schema.
→ Low risk. The notifications values structure has been stable since ArgoCD 2.6+. Pin chart version (already done: 9.4.0).
