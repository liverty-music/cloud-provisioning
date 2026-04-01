<poly-repo-context repo="cloud-provisioning">
  <responsibilities>GCP infrastructure via Pulumi (TypeScript). Kubernetes manifests
  managed by ArgoCD with Kustomize base/overlays. Multi-environment (dev/staging/prod).</responsibilities>
  <essential-commands>
    make lint              # All linters: biome + tsc + kustomize render + kube-linter + spot check
    make lint-ts           # TypeScript only: biome check + tsc (matches CI)
    make lint-k8s          # K8s manifests: render + kube-linter + spot nodeSelector check
    make fix               # Auto-fix formatting (biome check --write)
    make check             # Pre-commit check (lint-ts; lint-k8s requires kustomize/kube-linter)
    pulumi preview         # Preview infra changes
    pulumi up              # Deploy (requires user approval)
  </essential-commands>
</poly-repo-context>

<agent-rules>

## Operating Protocols

### Pulumi Deployment Approval

Before executing `pulumi up` or any deployment command, follow this workflow:

1. **Preview first**: Run `pulumi preview` (or `pulumi preview --diff`)
2. **Present to user**: Show the preview output, highlight destructive operations (deletions, replacements)
3. **Wait for explicit approval**: Do not proceed until the user says "yes", "proceed", or "approve"
4. **Execute**: Only after approval, run `pulumi up`

Never skip this workflow, even for small changes. Exception: the user has given explicit advance authorization for a specific deployment in the current session.

### Kubernetes Manifest Dry-Run

Before committing any changes to `k8s/` manifests, run a Kustomize dry-run:

```bash
# Plain Kustomize overlays (no Helm)
kubectl kustomize k8s/<path>/overlays/<env>

# Helm-based overlays (ESO, Reloader, etc.)
kubectl kustomize --enable-helm k8s/<path>/overlays/<env>
```

Check `k8s/<path>/base/kustomization.yaml` for `helmCharts:` to determine if `--enable-helm` is needed.

Verify:
- All targeted resources render without errors
- Patches apply to the correct resources (name, nodeSelector, replicas)
- No unintended resources are modified

Do not commit if `kubectl kustomize` returns an error or patches are missing.

### Dev Cost Optimization

When creating or modifying Kubernetes workload manifests for `dev` environment:

1. **Explicit resource requests/limits**: Every container needs `resources.requests` and `resources.limits` for CPU and memory.

2. **Spot VM nodeSelector**: Every Pod template needs:
   ```yaml
   nodeSelector:
     cloud.google.com/gke-spot: "true"
   ```

3. **Disable non-essential sidecars**: Debug tools (e.g., nats-box), test pods, and optional sidecars should be disabled in dev overlays unless actively needed.

4. **Verify before commit**: In the Kustomize dry-run, also check that no container has empty `resources: {}`, all workloads have `gke-spot: "true"` nodeSelector, and no unnecessary Pods are rendered.

## ESC Secret Management

This project uses Pulumi ESC (Environment, Secrets, and Configuration) for all configuration and secrets.

### ESC Environment Hierarchy

```
liverty-music/common          ← shared config inherited by all envs
├── liverty-music/dev          ← dev-specific config (imports common)
└── liverty-music/prod         ← prod-specific config (imports common)

liverty-music/cloud-provisioning/common  ← project-level shared config
├── liverty-music/cloud-provisioning/dev  ← project dev (imports above)
└── liverty-music/cloud-provisioning/prod
```

### `esc env set` vs `pulumi config set`

This distinction is critical — using the wrong command stores secrets in the wrong location:

- **`pulumi config set --secret`**: Writes to the stack YAML file or common ESC environment. Wrong for environment-specific secrets.
- **`esc env set`**: Writes directly to a specific ESC environment. This is the correct approach.

```bash
# Correct: writes to liverty-music/dev ESC environment
esc env set liverty-music/dev pulumiConfig.gcp.someSecret "value" --secret

# Wrong: may write to common env or stack file
pulumi -s dev config set --secret --path 'liverty-music:gcp.someSecret' "value"
```

### ESC Path Mapping

| ESC Path | Pulumi Config Key |
|----------|-------------------|
| `pulumiConfig.gcp.billingAccount` | `liverty-music:gcp.billingAccount` |
| `pulumiConfig.gcp.postgresAdminPassword` | `liverty-music:gcp.postgresAdminPassword` |
| `pulumiConfig.github.token` | `liverty-music:github.token` |

### Common ESC Commands

```bash
esc env ls                                              # List all environments
esc env get liverty-music/dev                           # View resolved values
esc env set liverty-music/dev pulumiConfig.gcp.key "v" --secret  # Set secret
esc env set liverty-music/dev pulumiConfig.gcp.key "v"  # Set plaintext
```

## Configuration

All configuration and secrets are managed through Pulumi ESC. Use `esc env set` for environment-specific secrets. Stack YAML files (`Pulumi.{env}.yaml`) reference ESC environments.

Store secrets in Pulumi ESC — hardcoded secrets in code are exposed in version control. Use IAM roles instead of service account keys. Use GCP Secret Manager for application secrets.

## File Organization

- **`src/index.ts`**: Main entry point dispatching to GCP and GitHub components
- **`src/gcp/`**: GCP infrastructure
  - **`config/`**: Configuration management (`constants.ts`, `environments.ts`)
  - **`components/`**: Infrastructure components (`project.ts`, `network.ts`, `kubernetes.ts`, `postgres.ts`, `workload-identity.ts`, `concert-data-store.ts`)
  - **`services/`**: API enablement helpers
- **`src/github/`**: GitHub organization and repository management
- **`k8s/`**: Kubernetes manifests managed by ArgoCD
  - **`argocd-apps/dev/`**: ArgoCD Application definitions
  - **`namespaces/`**: Per-namespace Kustomize bases and overlays

## Code Conventions

- Use kebab-case for Pulumi resource names: `my-storage-bucket`
- GCP region defaults to `asia-northeast2` via `DEFAULT_REGION` constant

## Infrastructure Patterns

1. **Organization/Project** (`project.ts`): Folders, projects, billing, Secret Manager
2. **Networking** (`network.ts`): Custom VPC, Cloud NAT, Private Service Connect
3. **Compute/GKE** (`kubernetes.ts`): GKE Autopilot, Workload Identity
4. **Database** (`postgres.ts`): Cloud SQL PostgreSQL 18, PSC-only, IAM auth
5. **GitOps/ArgoCD** (`k8s/`): App of Apps pattern, Kustomize overlays, Atlas Operator, ESO

## Stack Management

- **dev**: Development environment
- **staging**: Staging environment (mirrors production)
- **prod**: Production environment (restricted access)

```bash
pulumi stack select dev
pulumi stack select staging
pulumi stack select prod
```

</agent-rules>
