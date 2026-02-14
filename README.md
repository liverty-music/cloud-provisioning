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

## Outputs

- `folder` – The created organization folder
- `project` – The GCP project with configured billing
- `enabledServices` – List of enabled GCP services

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
├── tsconfig.json               # TypeScript compiler configuration
├── CLAUDE.md                   # AI assistant project instructions
└── src/
    ├── index.ts                # Main infrastructure entry point
    ├── config/
    │   ├── index.ts            # Configuration exports
    │   ├── constants.ts        # Project constants and API definitions
    │   └── environments.ts     # Environment-specific configurations
    └── components/             # Reusable infrastructure components (planned)
        ├── compute/            # Compute resources (VMs, GKE, etc.)
        ├── networking/         # VPC, subnets, firewall rules
        ├── security/           # IAM, secrets, policies
        └── storage/            # Cloud Storage, databases
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
  - cloud-provisioning/dev # or cloud-provisioning/prod
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

## Current Implementation

This project currently manages:

- **GitHub Organization**: Liverty Music organization settings and configuration
- **GitHub Repositories**: Automated repository creation with templates:
  - `cloud-provisioning` - This infrastructure repository
  - `schema` - Protocol buffer schemas repository
- **GCP Organization Folder**: Organizational structure for Liverty Music projects
- **GCP Projects**: Environment-specific projects (dev/prod) with proper billing
- **GCP Services**: Automated API enablement for required services

- **Network Resources**: Custom VPC (`liverty-music`), Subnets (Osaka), Cloud NAT
- **Compute Resources**: GKE Autopilot Cluster (`osaka-region`) with Private Nodes
- **Storage/Database**: Cloud SQL PostgreSQL 18 with Private Service Connect (PSC) & Cloud DNS

## Future Enhancements

- **Security policies** (Refined IAM roles, service accounts)
- **CI/CD Pipelines** (GitHub Actions integration with WIF)

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
