## Why

The current monitoring setup only covers application-level log errors (backend ERROR logs, Atlas migration failures) via GCP Cloud Monitoring. There is no alerting for Kubernetes deployment-level failures such as sync errors, health degradation (CrashLoopBackOff, ImagePullBackOff, OOMKilled), or unknown sync states. ArgoCD manages all workloads but its built-in Notifications feature is disabled, leaving a significant observability gap.

## What Changes

- Enable ArgoCD Notifications controller in the existing ArgoCD Helm deployment
- Configure Google Chat as the notification destination using incoming webhooks
- Set up default triggers for all ArgoCD Applications:
  - `on-sync-failed` — detects sync operation failures (Error/Failed phase)
  - `on-health-degraded` — detects health degradation (CrashLoopBackOff, ImagePullBackOff, probe failures, etc.)
  - `on-sync-status-unknown` — detects unknown sync states (potential connectivity or config issues)
- Create a dedicated ClusterSecretStore for the `argocd` namespace (separate from backend secrets)
- Manage the Google Chat webhook URL through Pulumi ESC → GCP Secret Manager → ESO → K8s Secret pipeline

## Capabilities

### New Capabilities
- `argocd-deployment-alerts`: Automated Google Chat notifications for ArgoCD Application sync failures, health degradation, and unknown sync states across all managed workloads.

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- **K8s manifests**: ArgoCD Helm values (enable notifications), new ClusterSecretStore, new ExternalSecret in argocd namespace
- **Pulumi code**: GcpConfig interface extended with webhook URL field, new GCP Secret Manager secret for the webhook URL
- **Pulumi ESC**: New secret entry for Google Chat webhook URL per environment
- **ArgoCD Applications**: All 10 apps receive notifications via `defaultTriggers` (no per-app annotation changes needed)
- **Google Chat**: Requires a Space with an incoming webhook URL configured
