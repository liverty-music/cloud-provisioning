# Cloud Provisioning

Liverty Music's cloud infrastructure provisioning using Pulumi and TypeScript. This project manages both GitHub organization/repositories and GCP infrastructure across multiple environments.

## Overview

This project provisions and manages cloud resources for Liverty Music, including:

- GitHub organization settings and repository management
- GCP organizational resources (folders, projects, and services)
- Multi-environment support (dev/prod) with proper configuration management

## Providers

- `@pulumi/pulumi`
- `@pulumi/github`
- `@pulumi/gcp`

## Resources Created

### GitHub Resources

- **Organization Settings** (`github.OrganizationSettings`) - GitHub organization configuration
- **Repositories** (`github.Repository`) - Managed repositories with templates

### GCP Resources

- **Organization Folder** (`gcp.organizations.Folder`) - Organizational folder for project grouping
- **GCP Project** (`gcp.organizations.Project`) - Environment-specific projects with billing
- **Enabled Services** (`gcp.projects.Service`) - Required GCP APIs for each environment
- **Network** - Custom VPC, subnets (Osaka), Cloud NAT, firewall rules
- **GKE Autopilot** - Private cluster with Workload Identity
- **Cloud SQL** - PostgreSQL 18 with PSC-only connectivity, IAM database authentication
- **Secret Manager** - Application secrets (e.g., `postgres-admin-password`)
- **Artifact Registry** - Container image repositories for backend and frontend
- **Cloud DNS** - Private zones for PSC endpoint resolution

### Kubernetes Resources (via ArgoCD)

- **ArgoCD** - GitOps controller (Helm-based)
- **External Secrets Operator** - Syncs GCP Secret Manager → K8s Secrets
- **Atlas Operator** - Database migration management via CRDs
- **Gateway API** - Ingress routing with Google-managed TLS
- **Reloader** - Automatic pod restarts on ConfigMap/Secret changes

## Prerequisites

- **Node.js 22+**
- **Pulumi CLI** installed and configured
- **GitHub Personal Access Token** with organization management permissions
- **GCP Organization** with billing account access
- **Organization Admin** permissions for folder and project creation
- **GCP credentials** configured (via `gcloud auth application-default login`)
- **Pulumi configuration** set (see Configuration section)

## Getting Started

1. **Clone this repository:**

   ```bash
   git clone <repository-url>
   cd cloud-provisioning
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Initialize Pulumi stacks:**

   ```bash
   # Create and configure each environment
   pulumi stack init dev
   pulumi stack init prod
   ```

4. **Configuration is managed by Pulumi ESC:**
   All configuration including credentials, secrets, and environment-specific settings are managed through Pulumi ESC (Environment, Secrets, and Configuration). The stack configuration files reference ESC environments for secure, centralized configuration management.

## Project Layout

```
.
├── Pulumi.yaml                  # Pulumi project definition
├── Pulumi.{dev,prod}.yaml       # Stack-specific configurations with ESC references
├── package.json                 # Node.js dependencies and scripts
├── tsconfig.json                # TypeScript compiler configuration
├── CLAUDE.md                    # AI assistant project instructions
├── AGENTS.md                    # AI agent context (ESC, architecture)
├── src/
│   ├── index.ts                 # Main entry point (dispatches to GCP + GitHub)
│   ├── gcp/
│   │   ├── index.ts             # GCP stack entry point
│   │   ├── config/              # Constants, environment configs
│   │   ├── components/          # Infrastructure components
│   │   │   ├── project.ts       # GCP project, folder, services, Secret Manager
│   │   │   ├── network.ts       # VPC, subnets, Cloud NAT
│   │   │   ├── kubernetes.ts    # GKE Autopilot cluster
│   │   │   ├── postgres.ts      # Cloud SQL PostgreSQL 18, PSC, IAM users
│   │   │   ├── workload-identity.ts  # Workload Identity Federation
│   │   │   └── concert-data-store.ts # Vertex AI Search
│   │   └── services/            # API enablement helpers
│   └── github/                  # GitHub org & repo management
├── k8s/
│   ├── argocd-apps/dev/         # ArgoCD Application definitions
│   ├── cluster/                 # Cluster-wide resources (namespaces)
│   └── namespaces/              # Per-namespace Kustomize manifests
│       ├── argocd/              # ArgoCD server (Helm-based)
│       ├── atlas-operator/      # Atlas Operator (Helm-based)
│       ├── backend/             # Backend Deployment, Service, ConfigMap
│       ├── external-secrets/    # External Secrets Operator
│       ├── frontend/            # Frontend Deployment, Service
│       ├── gateway/             # Gateway API resources
│       └── reloader/            # Reloader for ConfigMap/Secret rotation
└── docs/                        # Operational runbooks
```

## Configuration

### Pulumi ESC Integration

Configuration and secrets are managed through Pulumi ESC (Environment, Secrets, and Configuration):

- **GitHub Configuration**: GitHub organization settings, authentication tokens, and repository templates
- **GCP Configuration**: Organization ID, billing account, and regional settings
- **Environment-specific Settings**: Different configurations for dev and prod environments

The stack configuration files (`Pulumi.{dev,prod}.yaml`) reference ESC environments using the format:

```yaml
environment:
  - liverty-music/dev # or liverty-music/prod
```

This provides secure, centralized configuration management with dynamic secrets and proper access controls.

### Stack Management

Switch between environments:

```bash
pulumi stack select dev       # Development environment
pulumi stack select prod      # Production environment
```

## Development

### Available Scripts

- `npm run lint` – Lint code with Biome
- `npm run format` – Format code with Biome
- `npm run check` – Run Biome checks (combines lint and format)
- `npm run typecheck` – Run TypeScript type checking
- `npm run build` – Compile TypeScript to JavaScript
- `npm run dev` – Watch mode for development

### Node.js Requirements

This project requires Node.js 22+ as specified in `package.json`:

```json
"engines": {
  "node": ">=22.0.0"
}
```

## Database Migration Architecture

Database schema migrations are managed by the **Atlas Kubernetes Operator** running inside GKE. This replaces the previous goose app-startup migration pattern.

### How It Works

1. Migration SQL files are maintained in the `backend` repository under `k8s/atlas/base/migrations/`
2. Kustomize generates a ConfigMap from the migration files
3. An `AtlasMigration` CRD references the ConfigMap and connects to Cloud SQL as the `postgres` user
4. ArgoCD syncs the migration resources from the backend repo via a dedicated `backend-migrations` Application
5. Sync wave ordering ensures migrations complete before the backend Deployment starts

### Key Components

- **Atlas Operator**: Installed via Helm in `atlas-operator` namespace (managed in this repo)
- **AtlasMigration CRD + ConfigMap**: Defined in `backend` repo (`k8s/atlas/`)
- **ArgoCD Application**: `backend-migrations` syncs from `backend` repo's `k8s/atlas/overlays/dev`
- **ExternalSecret**: Syncs `postgres-admin-password` from Secret Manager to K8s Secret in `atlas-operator` namespace

## Frontend Deployment Architecture

The Aurelia 2 frontend SPA is deployed to GKE using GitOps with ArgoCD, following the same patterns as the backend.

### Infrastructure Components

**Container Image Pipeline**:
- Multi-stage Docker build: `node:22-alpine` (builder) → `caddy:2-alpine` (runtime)
- Automated builds on push to `main` branch via GitHub Actions
- Images pushed to Google Artifact Registry: `asia-northeast2-docker.pkg.dev/liverty-music-dev/frontend/web-app`
- Tagged with: `latest`, `${GITHUB_SHA}`, `main`

**Kubernetes Resources**:
- **Namespace**: `frontend`
- **Deployment**: 1 replica, 50m-200m CPU, 64Mi-128Mi memory, spot VMs
- **Service**: ClusterIP on port 80
- **HTTPRoute**: Gateway API route binding to `external-gateway`
- **Web Server**: Caddy 2 serving static assets from `/srv`

**Network & TLS**:
- **Domain**: `https://dev.liverty-music.app`
- **Gateway**: Shared `external-gateway` in `gateway` namespace (same as backend)
- **Static IP**: Shared `api-gateway-static-ip` (routing by hostname)
- **Certificate**: Google-managed TLS via `api-gateway-cert-map`
- **DNS**: Cloud DNS A record pointing to shared static IP

**GitOps Workflow**:
1. Frontend code changes merged to `main` → GitHub Actions builds Docker image
2. ArgoCD monitors `k8s/namespaces/frontend/overlays/dev` in this repository
3. Kustomize applies base manifests + dev overlays
4. ArgoCD syncs changes to cluster (auto-prune, self-heal)

### SPA Routing

Caddy is configured with `try_files {path} /index.html` to support client-side routing:
- Static assets (`/assets/*.js`, `/favicon.ico`) served directly
- All other routes fallback to `index.html` for Aurelia 2 router to handle
- Enables direct access to client-side routes (e.g., `/concerts`, `/users`)

### Environment URLs

- **Dev Frontend**: https://dev.liverty-music.app
- **Dev Backend API**: https://api.dev.liverty-music.app

### Deployment Verification

After deploying, verify the following:
- ArgoCD sync status (Healthy/Synced)
- Pod health checks (`kubectl get pods -n frontend`)
- HTTPRoute binding verification (`kubectl get httproute -n frontend`)
- TLS certificate validation (`curl -sI https://dev.liverty-music.app`)
- SPA routing tests (`curl -s https://dev.liverty-music.app/concerts`)

## Future Enhancements

- **Security policies** (Refined IAM roles, service accounts)
- **CI/CD Pipelines** (GitHub Actions integration with WIF)

## Cloud SQL Admin Password Setup

The Cloud SQL `postgres` admin user password must be generated locally and stored in the Pulumi config before deploying. This password is used by:

- **Pulumi**: Sets the `postgres` user password on the Cloud SQL instance via `gcp.sql.User`
- **Secret Manager**: Stored as `postgres-admin-password` for Atlas Operator to authenticate
- **Atlas Operator**: Connects to Cloud SQL as `postgres` to run schema migrations

### Generate and Configure the Password

```bash
# 1. Generate a secure random password (32 chars, alphanumeric)
PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)

# 2. Store in the dev ESC environment as a secret
#    This writes to liverty-music/dev ESC env under pulumiConfig.gcp.postgresAdminPassword
esc env set liverty-music/dev pulumiConfig.gcp.postgresAdminPassword "$PASSWORD" --secret

# 3. Verify it was stored
esc env get liverty-music/dev pulumiConfig.gcp.postgresAdminPassword
```

### What Happens on `pulumi up`

1. `gcp.sql.User` sets the `postgres` user password on the Cloud SQL instance
2. `gcp.secretmanager.SecretVersion` stores the password in Secret Manager as `postgres-admin-password`
3. External Secrets Operator (ESO) syncs the secret to a K8s `Secret` in the `atlas-operator` namespace
4. Atlas Operator reads the secret to authenticate against Cloud SQL for migrations

### Rotation

To rotate the password, re-run the steps above with a new value and run `pulumi up`. The Cloud SQL user password and Secret Manager version will be updated automatically. The ESO sync interval will propagate the new secret to K8s.

## Kubernetes & ArgoCD Bootstrap

When setting up a fresh cluster (e.g., `cluster-osaka`), follow these steps to bootstrap the environment.

### 1. Authenticate to the Cluster

```bash
gcloud container clusters get-credentials cluster-osaka --region asia-northeast2 --project liverty-music-dev
```

### 2. Create Namespaces

Create the required namespaces (`argocd`, `backend`):

```bash
kubectl apply -f k8s/cluster/namespaces.yaml
```

### 3. Install ArgoCD

Install ArgoCD using Kustomize with Helm support. This uses the `dev` overlay by default.

```bash
kubectl kustomize --enable-helm k8s/namespaces/argocd/overlays/dev | kubectl apply --server-side --force-conflicts -f -
```

### 4. Apply Root Application

Bootstrap the "App of Apps" pattern by applying the Root Application:

```bash
kubectl apply -f k8s/namespaces/argocd/base/root-app.yaml
```

## Accessing Infrastructure

### ArgoCD UI

To access the ArgoCD UI, use port-forwarding:

```bash
# Forward to the HTTP port (80)
kubectl port-forward svc/argocd-server -n argocd 8080:80
```

Then visit [http://localhost:8080](http://localhost:8080).

- **Username**: `admin`
- **Password**: Get the initial password by running:
  ```bash
  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d; echo
  ```

## Resources

- [Pulumi ESC Documentation](https://www.pulumi.com/docs/esc/)
- [Pulumi GitHub Provider Documentation](https://www.pulumi.com/docs/reference/pkg/github/)
- [Pulumi GCP Provider Documentation](https://www.pulumi.com/docs/reference/pkg/gcp/)
- [Pulumi TypeScript Guide](https://www.pulumi.com/docs/get-started/typescript/)

## Getting Help

If you run into issues or have questions, check out:

- Pulumi Documentation: https://www.pulumi.com/docs/
- Community Slack: https://slack.pulumi.com/
- GitHub Issues: https://github.com/pulumi/pulumi/issues
