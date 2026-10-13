# ArgoCD Setup Guide

This directory contains the Kubernetes manifests for setting up ArgoCD in the `liverty-music` clusters.

## Prerequisites

- `kubectl` installed (v1.27+ for OCI support)
- `kustomize` installed (optional, can use `kubectl kustomize`)
- `helm` installed (required for chart inflation)
- `gcloud` authenticated with cluster access

## Directory Structure

```
k8s/
├── argocd-apps/            # App of Apps definitions
│   ├── dev/                # Dev environment applications
│   └── prod/               # Prod environment applications
├── cluster/                # Core cluster resources
│   └── namespaces.yaml     # Namespace definitions
└── namespaces/             # Workload manifests
    └── argocd/             # ArgoCD manifests
        ├── base/           # Shared Kustomize base (OCI Helm Chart: argo-cd)
        │   └── kustomization.yaml
        └── overlays/
            ├── dev/        # Dev environment (root-app.yaml → argocd-apps/dev)
            └── prod/       # Prod environment (root-app.yaml → argocd-apps/prod)
```

## Bootstrap Instructions

### 1. Create Namespace

```bash
kubectl apply -f k8s/cluster/namespaces.yaml
```

### 2. Development Environment

**Install ArgoCD:**

````bash
# 1. Switch context to dev cluster
gcloud container clusters get-credentials cluster-dev --region <REGION> --project <PROJECT_ID>

# 2. Apply ArgoCD Manifests (requires --enable-helm)
# Note: --server-side is required to handle large CRDs.
# Use --force-conflicts if you previously ran without --server-side.
kubectl kustomize --enable-helm k8s/namespaces/argocd/overlays/dev | kubectl apply --server-side --force-conflicts -f -

```sh
customresourcedefinition.apiextensions.k8s.io/applications.argoproj.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/applicationsets.argoproj.io serverside-applied
customresourcedefinition.apiextensions.k8s.io/appprojects.argoproj.io serverside-applied
serviceaccount/argocd-application-controller serverside-applied
serviceaccount/argocd-applicationset-controller serverside-applied
serviceaccount/argocd-dex-server serverside-applied
serviceaccount/argocd-notifications-controller serverside-applied
serviceaccount/argocd-redis-secret-init serverside-applied
serviceaccount/argocd-repo-server serverside-applied
serviceaccount/argocd-server serverside-applied
role.rbac.authorization.k8s.io/argocd-application-controller serverside-applied
role.rbac.authorization.k8s.io/argocd-applicationset-controller serverside-applied
role.rbac.authorization.k8s.io/argocd-dex-server serverside-applied
role.rbac.authorization.k8s.io/argocd-notifications-controller serverside-applied
role.rbac.authorization.k8s.io/argocd-redis-secret-init serverside-applied
role.rbac.authorization.k8s.io/argocd-repo-server serverside-applied
role.rbac.authorization.k8s.io/argocd-server serverside-applied
clusterrole.rbac.authorization.k8s.io/argocd-application-controller serverside-applied
clusterrole.rbac.authorization.k8s.io/argocd-notifications-controller serverside-applied
clusterrole.rbac.authorization.k8s.io/argocd-server serverside-applied
rolebinding.rbac.authorization.k8s.io/argocd-application-controller serverside-applied
rolebinding.rbac.authorization.k8s.io/argocd-applicationset-controller serverside-applied
rolebinding.rbac.authorization.k8s.io/argocd-dex-server serverside-applied
rolebinding.rbac.authorization.k8s.io/argocd-notifications-controller serverside-applied
rolebinding.rbac.authorization.k8s.io/argocd-redis-secret-init serverside-applied
rolebinding.rbac.authorization.k8s.io/argocd-repo-server serverside-applied
rolebinding.rbac.authorization.k8s.io/argocd-server serverside-applied
clusterrolebinding.rbac.authorization.k8s.io/argocd-application-controller serverside-applied
clusterrolebinding.rbac.authorization.k8s.io/argocd-notifications-controller serverside-applied
clusterrolebinding.rbac.authorization.k8s.io/argocd-server serverside-applied
configmap/argocd-cm serverside-applied
configmap/argocd-cmd-params-cm serverside-applied
configmap/argocd-gpg-keys-cm serverside-applied
configmap/argocd-notifications-cm serverside-applied
configmap/argocd-rbac-cm serverside-applied
configmap/argocd-redis-health-configmap serverside-applied
configmap/argocd-ssh-known-hosts-cm serverside-applied
configmap/argocd-tls-certs-cm serverside-applied
secret/argocd-notifications-secret serverside-applied
secret/argocd-secret serverside-applied
service/argocd-applicationset-controller serverside-applied
service/argocd-dex-server serverside-applied
service/argocd-redis serverside-applied
service/argocd-repo-server serverside-applied
service/argocd-server serverside-applied
deployment.apps/argocd-applicationset-controller serverside-applied
deployment.apps/argocd-dex-server serverside-applied
deployment.apps/argocd-notifications-controller serverside-applied
deployment.apps/argocd-redis serverside-applied
deployment.apps/argocd-repo-server serverside-applied
deployment.apps/argocd-server serverside-applied
statefulset.apps/argocd-application-controller serverside-applied
Warning: autopilot-default-resources-mutator:Autopilot updated Job argocd/argocd-redis-secret-init: defaulted unspecified 'cpu' resource for containers [secret-init] (see http://g.co/gke/autopilot-defaults).
job.batch/argocd-redis-secret-init serverside-applied
````

The overlay includes the env's Root Application (`root-app.yaml`), so this
apply also bootstraps the App of Apps: `root-app` syncs every Application
under `k8s/argocd-apps/<env>`, including the `argocd` Application that keeps
`root-app` itself in sync. No separate root-app apply is needed.

### 3. Production Environment

**Install ArgoCD:**

```bash
# 1. Switch context to prod cluster
gcloud container clusters get-credentials cluster-prod --region <REGION> --project <PROJECT_ID>

# 2. Apply ArgoCD Manifests (includes the prod root-app → k8s/argocd-apps/prod)
kubectl kustomize --enable-helm k8s/namespaces/argocd/overlays/prod | kubectl apply --server-side -f -
````

**Access UI:**

```bash
# 1. Get Admin Password
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d; echo

# 2. Port Forward
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

## Notifications

`argocd-notifications-cm` is configured in `base/values.yaml` (`notifications:`). Every
Application is subscribed to the default triggers:

| Trigger | Fires when |
|---|---|
| `on-sync-failed` | the last sync operation ended in `Error` or `Failed` |
| `on-health-degraded` | health has been `Degraded` for 3 minutes (30 minutes in the dev overlay) |
| `on-health-progressing-stuck` | health has been `Progressing` for 15 minutes — e.g. Pods crash-looping after a completed rollout, which never turns `Degraded` |
| `on-sync-status-unknown` | sync status is `Unknown` |

Each trigger sends one template with two parts: a Google Chat `message` (to the
`alertSpace` webhook) and a `webhook.incident-triage` request that dispatches
`.github/workflows/incident-triage.yml` in `cloud-provisioning`, where Claude
investigates read-only and reports a GitHub Issue. The webhook authenticates with a
short-lived `liverty-music-cluster-bot` installation token that ESO mints into
`argocd-notifications-secret` (`base/github-access-token.yaml`,
`base/external-secret.yaml`).

See [docs/runbooks/incident-triage.md](../../../docs/runbooks/incident-triage.md) for the
architecture, the kill switch and key rotation.
