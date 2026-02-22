
# Claude Instructions for Public Cloud Scaffold

This file contains project-specific instructions for Claude when working with this Pulumi GCP Infrastructure as Code scaffold.

## Project Context

This is a comprehensive Pulumi-based Infrastructure as Code scaffold for Google Cloud Platform that focuses on organizational structure and multi-environment management. The project creates GCP folders, projects, and enables required services across development, staging, and production environments. It demonstrates enterprise-level IaC practices with proper configuration management, security, and scalability patterns.

### Key Features
- **Organization Management**: Creates GCP folders and projects with proper hierarchy
- **Multi-Environment Support**: Separate stacks for dev, staging, and prod environments  
- **Service Management**: Automated API enablement per environment
- **Configuration Driven**: Environment-specific settings via Pulumi config and constants
- **Billing Integration**: Automatic billing account association for projects
- **Modular Architecture**: Component-based structure for reusable infrastructure patterns

## Development Commands

### Pulumi Commands
```bash
# Preview infrastructure changes
pulumi preview

# Deploy infrastructure
pulumi up

# Check stack outputs
pulumi stack output

# View current configuration
pulumi config

# Destroy infrastructure
pulumi destroy
```

### Testing Commands
```bash
# Run Pulumi policy tests (if configured)
pulumi policy test

# Validate Pulumi configuration
pulumi config --show-secrets validate

# Dry run infrastructure changes
pulumi preview --diff
```

### Linting Commands
```bash
# TypeScript projects
npm run lint
npm run typecheck

# Python projects  
flake8 .
mypy .

# Go projects
golangci-lint run
go vet ./...
```

## Code Conventions

### Pulumi Resource Naming
- Use kebab-case for resource names: `my-storage-bucket`
- Include environment prefix: `dev-web-server`, `prod-database`
- Be descriptive and consistent across stacks

### File Organization
- **`src/index.ts`**: Main infrastructure entry point dispatching to GCP and GitHub components
- **`src/gcp/`**: GCP infrastructure
  - **`index.ts`**: GCP stack entry point
  - **`config/`**: Configuration management (`constants.ts`, `environments.ts`)
  - **`components/`**: Infrastructure components (flat structure)
    - **`project.ts`**: GCP project, folder, services, Secret Manager
    - **`network.ts`**: VPC, subnets, Cloud NAT, firewall rules
    - **`kubernetes.ts`**: GKE Autopilot cluster
    - **`postgres.ts`**: Cloud SQL PostgreSQL 18, PSC endpoint, DNS, IAM users
    - **`workload-identity.ts`**: Workload Identity Federation for GKE service accounts
    - **`concert-data-store.ts`**: Vertex AI Search data store
  - **`services/`**: API enablement helpers
- **`src/github/`**: GitHub organization and repository management
- **`k8s/`**: Kubernetes manifests managed by ArgoCD
  - **`argocd-apps/dev/`**: ArgoCD Application definitions (backend, frontend, atlas-operator, backend-migrations, etc.)
  - **`namespaces/`**: Per-namespace Kustomize bases and overlays (argocd, backend, frontend, atlas-operator, external-secrets, gateway, reloader)
- **`Pulumi.{env}.yaml`**: Stack-specific configurations referencing ESC environments
- **`.mise.toml`**: Node.js version management (v22)

### Configuration Management
- All configuration and secrets are managed through **Pulumi ESC** (see Security Guidelines below)
- Use `esc env set` (NOT `pulumi config set`) for environment-specific secrets
- Stack YAML files (`Pulumi.{env}.yaml`) reference ESC environments

### Optional Pulumi Configuration
- **`region`**: GCP region (defaults to `asia-northeast2` via DEFAULT_REGION constant)
- **`zone`**: Specific GCP zone within the region

## Security Guidelines

### Sensitive Data Handling
- NEVER hardcode secrets in infrastructure code
- Use Pulumi ESC (`esc env set ... --secret`) to store secrets in the correct environment
- Leverage GCP Secret Manager for application secrets
- Use IAM roles instead of service account keys when possible

### Pulumi ESC Secret Management

This project uses **Pulumi ESC** (Environment, Secrets, and Configuration) for all configuration and secrets. Secrets MUST be stored in the correct ESC environment, NOT in stack config files.

#### ESC Environment Hierarchy

```
liverty-music/common          ← shared config inherited by all envs
├── liverty-music/dev          ← dev-specific config (imports common)
└── liverty-music/prod         ← prod-specific config (imports common)

liverty-music/cloud-provisioning/common  ← project-level shared config
├── liverty-music/cloud-provisioning/dev  ← project dev (imports above)
└── liverty-music/cloud-provisioning/prod
```

Stack files (`Pulumi.dev.yaml`) reference ESC environments:
```yaml
environment:
  - liverty-music/dev
```

#### CRITICAL: `pulumi config set` vs `esc env set`

- **`pulumi config set --secret`**: Writes to the **stack YAML file** (`Pulumi.dev.yaml`) or the common ESC environment. This is WRONG for environment-specific secrets.
- **`esc env set`**: Writes directly to a **specific ESC environment**. This is the CORRECT approach.

#### Setting a Secret in a Specific ESC Environment

```bash
# Correct: writes to liverty-music/dev ESC environment
esc env set liverty-music/dev pulumiConfig.gcp.someSecret "value" --secret

# Wrong: may write to common env or stack file
pulumi -s dev config set --secret --path 'liverty-music:gcp.someSecret' "value"
```

#### ESC Path Mapping

ESC `pulumiConfig` keys map to Pulumi config namespaces:

| ESC Path | Pulumi Config Key |
|----------|-------------------|
| `pulumiConfig.gcp.billingAccount` | `liverty-music:gcp.billingAccount` |
| `pulumiConfig.gcp.postgresAdminPassword` | `liverty-music:gcp.postgresAdminPassword` |
| `pulumiConfig.github.token` | `liverty-music:github.token` |

#### Common ESC Commands

```bash
# List all environments
esc env ls

# View an environment's resolved values (secrets redacted)
esc env get liverty-music/dev

# View a specific value
esc env get liverty-music/dev pulumiConfig.gcp.postgresAdminPassword

# Set a secret value
esc env set liverty-music/dev pulumiConfig.gcp.someKey "value" --secret

# Set a plaintext value
esc env set liverty-music/dev pulumiConfig.gcp.someKey "value"

# View raw YAML definition (shows fn::secret ciphertexts)
esc env get liverty-music/dev --show-secrets
```

### GCP Best Practices
- Apply principle of least privilege for IAM roles
- Enable audit logging for critical resources
- Use VPC networks with appropriate firewall rules
- Implement resource tagging/labeling for cost management

## Operating Protocols

### Kubernetes Manifest Dry-Run Protocol

**MANDATORY**: Before creating any commit that includes changes to `k8s/` manifests, you MUST run a Kustomize dry-run to verify the rendered output is correct.

**Commands**:
```bash
# Plain Kustomize overlays (no Helm)
kubectl kustomize k8s/<path>/overlays/<env>

# Helm-based overlays (ESO, Reloader, etc.)
kubectl kustomize --enable-helm k8s/<path>/overlays/<env>
```

**What to verify**:
- All targeted resources are rendered without errors
- Patches are applied to the correct resources (check `name`, `nodeSelector`, `replicas`, etc.)
- No unintended resources are modified

**When Helm is required**: Any overlay whose base uses `helmCharts:` in `kustomization.yaml` requires `--enable-helm`. Check `k8s/<path>/base/kustomization.yaml` to determine this.

**Do NOT commit if**:
- `kubectl kustomize` returns an error
- A patch is missing from a resource that should have it (e.g., `nodeSelector: NOT SET` when expected)
- A resource has unexpected field values

### Pulumi Deployment Approval Protocol

**CRITICAL REQUIREMENT**: Before executing `pulumi up` or any deployment command, you MUST follow this strict approval workflow:

1. **Always Preview First**
   - Execute `pulumi preview` (or `pulumi preview --diff` for detailed changes)
   - Capture the complete output showing:
     - Resources to be created (+)
     - Resources to be modified (~)
     - Resources to be deleted (-)
     - Resource count summary

2. **Present to User**
   - Display the preview output to the user
   - Highlight any destructive operations (deletions, replacements)
   - Explain the impact of the changes in plain language
   - Note any potential risks or concerns

3. **Wait for Explicit Approval**
   - DO NOT proceed with `pulumi up` until the user explicitly approves
   - Accept only clear affirmative responses ("yes", "proceed", "approve", etc.)
   - If the user has questions or concerns, address them before deployment

4. **Execute Deployment**
   - Only after receiving explicit approval, execute `pulumi up`
   - Monitor the deployment progress
   - Report any errors or warnings immediately

**Never skip this workflow**, even for:
- Small or "obvious" changes
- Configuration updates
- Emergency fixes
- Automated scenarios

**Exception**: Only skip the approval step if the user has provided explicit advance authorization for a specific deployment in the current session (e.g., "preview and deploy the storage bucket we just discussed").

## Stack Management

### Environment Separation
- **dev**: Development environment (personal/shared dev project)
- **staging**: Staging environment (mirrors production)
- **prod**: Production environment (restricted access)

### Stack Switching
```bash
# Switch between stacks
pulumi stack select dev
pulumi stack select staging  
pulumi stack select prod
```

### Common Infrastructure Patterns

When implementing infrastructure, follow these patterns:

1. **Organization and Project Structure** (`project.ts`)
   - Create organization folders using descriptive names from FOLDER_NAME constant
   - Projects follow `{projectPrefix}-{environment}` naming pattern
   - Automatic billing account association via ESC config
   - Secret Manager secrets for application credentials (e.g., `postgres-admin-password`)

2. **Networking** (`network.ts`)
   - Custom VPC (`liverty-music`) with regional subnets
   - Cloud NAT for outbound internet access
   - Private Service Connect (PSC) for Cloud SQL connectivity

3. **Compute / GKE** (`kubernetes.ts`)
   - GKE Autopilot cluster with private nodes
   - Workload Identity for pod-level GCP authentication

4. **Database** (`postgres.ts`)
   - Cloud SQL PostgreSQL 18 with PSC-only connectivity (no public IP)
   - IAM database authentication for application service accounts
   - Built-in `postgres` user with password for Atlas Operator migrations
   - DNS records for PSC endpoint resolution

5. **GitOps / ArgoCD** (`k8s/`)
   - "App of Apps" pattern via root ArgoCD Application
   - Per-namespace Kustomize bases with environment overlays
   - Atlas Operator for database migrations (synced from backend repo)
   - External Secrets Operator for GCP Secret Manager → K8s Secret sync

## Troubleshooting

### Common Issues

1. **Authentication Problems**
   ```bash
   # Re-authenticate with GCP
   gcloud auth application-default login
   
   # Verify project setting
   gcloud config get-value project
   ```

2. **State Management Issues**
   ```bash
   # Refresh Pulumi state
   pulumi refresh
   
   # Import existing resources
   pulumi import gcp:storage/bucket:Bucket my-bucket my-existing-bucket
   ```

3. **Configuration Problems**
   ```bash
   # List all configurations
   pulumi config
   
   # Reset configuration
   pulumi config rm problematic-key
   pulumi config set correct-key correct-value
   ```

## CI/CD Integration

### Required Environment Variables
- `PULUMI_ACCESS_TOKEN`: Pulumi Cloud access token
- `GOOGLE_CREDENTIALS`: GCP service account key (base64 encoded)
- `PULUMI_CONFIG_PASSPHRASE`: Stack encryption passphrase
- `GCP_ORGANIZATION_ID`: Organization ID for folder/project creation
- `GCP_BILLING_ACCOUNT`: Billing account for project association

### Deployment Workflow
1. `pulumi preview` on pull requests
2. `pulumi up` on merge to main branch
3. Separate workflows for different environments

## Resource Cleanup

### Development Cleanup
```bash
# Clean up development resources
pulumi stack select dev
pulumi destroy

# Remove development stack
pulumi stack rm dev
```

### Emergency Procedures
```bash
# Force destroy stuck resources
pulumi destroy --force

# Skip dependency checks (use with caution)
pulumi destroy --skip-dependency-check
```

## Performance Optimization

### Pulumi Best Practices
- Use `pulumi.all()` for multiple async operations
- Implement resource dependencies explicitly
- Use stack references for cross-stack dependencies
- Cache provider clients when possible

### GCP Cost Optimization
- Implement automatic scaling policies
- Use preemptible instances for non-critical workloads
- Set up budget alerts and quotas
- Regular resource usage reviews

## Documentation Requirements

When adding new infrastructure components:

1. **Document resource purpose and configuration**
2. **Add examples of common usage patterns**
3. **Include troubleshooting tips for common issues**
4. **Update this CLAUDE.md with any new patterns or commands**

## Additional Resources

- [Pulumi GCP Examples](https://github.com/pulumi/examples/tree/master/gcp-ts-gke)
- [GCP Architecture Center](https://cloud.google.com/architecture)
- [Pulumi Best Practices](https://www.pulumi.com/docs/intro/concepts/programming-model/#best-practices)
