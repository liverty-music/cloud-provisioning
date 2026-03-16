## 1. Pulumi: Webhook URL Secret Management

- [x] 1.1 Add `argocdGoogleChatWebhookUrl` field to `GcpConfig` interface in `src/gcp/components/project.ts`
- [x] 1.2 Create `gcp.secretmanager.Secret` and `SecretVersion` for `argocd-google-chat-webhook-url` in `src/gcp/components/kubernetes.ts` with ESO-only IAM binding (no backend-app SA access)
- [x] 1.3 Register webhook URL in Pulumi ESC dev environment: `esc env set liverty-music/dev pulumiConfig.gcp.argocdGoogleChatWebhookUrl "<url>" --secret`

## 2. K8s: ClusterSecretStore for ArgoCD

- [x] 2.1 Create `k8s/cluster/base/cluster-secret-store-argocd.yaml` — ClusterSecretStore restricted to `argocd` namespace with placeholder projectID
- [x] 2.2 Add `cluster-secret-store-argocd.yaml` to `k8s/cluster/base/kustomization.yaml` resources
- [x] 2.3 Create `k8s/cluster/overlays/dev/cluster-secret-store-argocd-patch.yaml` with dev projectID
- [x] 2.4 Add patch target to `k8s/cluster/overlays/dev/kustomization.yaml`

## 3. K8s: ArgoCD ExternalSecret

- [x] 3.1 Create `k8s/namespaces/argocd/base/external-secret.yaml` — ExternalSecret that creates `argocd-notifications-secret` from GCP Secret Manager key `argocd-google-chat-webhook-url`

## 4. K8s: Enable ArgoCD Notifications

- [x] 4.1 Update `k8s/namespaces/argocd/base/values.yaml`: set `notifications.enabled: true` with resource requests/limits
- [x] 4.2 Configure `notifications.secret.create: false` to let ESO manage the secret
- [x] 4.3 Add `notifications.cm` with `service.googlechat` webhook config referencing `$google-chat-webhook-url`
- [x] 4.4 Add `notifications.triggers` with `defaultTriggers` (on-sync-failed, on-health-degraded, on-sync-status-unknown) and trigger definitions
- [x] 4.5 Add `notifications.templates` with notification templates for each trigger

## 5. Validation

- [x] 5.1 Run `kubectl kustomize --enable-helm k8s/namespaces/argocd/overlays/dev` and verify notifications resources render correctly
- [x] 5.2 Run `kubectl kustomize k8s/cluster/overlays/dev` and verify both ClusterSecretStores render
- [x] 5.3 Run `make check` to verify linting passes
