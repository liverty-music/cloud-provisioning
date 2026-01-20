## Context

To achieve secure, managed deployments, we must first establish trust between Pulumi Cloud and Google Cloud. This requires provisioning Workload Identity Federation (WIF) resources in GCP, which will then be used by the Pulumi Cloud Deployments engine to authenticate without long-lived keys.

## Goals

- Provision WIF infrastructure as code within the same Pulumi project.
- Achieve "keyless" deployments using native Pulumi Cloud OIDC.
- Follow the official [GCP OIDC integration guide](https://www.pulumi.com/docs/deployments/deployments/oidc/gcp/).
- Simplify CI/CD by moving from GitHub Actions CLI to Pulumi Cloud's managed engine.

## Decisions

- **Decision: WIF Resources as a Pulumi Component**
  - We use a custom `WorkloadIdentityFederation` component to encapsulate the creation of the Pool, Provider, and Service Account.
  - Rationale: Reusable across `dev` and `prod` environments, ensuring consistency.

- **Decision: Use Native OIDC Integration**
  - We configure OIDC settings directly in the Pulumi Console's "Deploy" panel rather than using custom ESC environments for basic deployment auth.
  - Rationale: Standard path for managed deployments, reduces architectural complexity.

- **Decision: Trigger via Pulumi GitHub App**
  - Use the official Pulumi GitHub App to trigger managed deployments on PRs and merges.
  - **PR Workflow**: `dev` stack will auto-deploy (`up`) to allow immediate testing; `prod` stack will only `preview`.
  - **Merge Workflow**: `prod` stack will deploy (`up`) upon merging to `main`.
  - Rationale: High-velocity testing in `dev` while maintaining safety gates for `prod`.

## Risks / Trade-offs

- **Risk**: Circular dependency (using Pulumi to create the infrastructure that Pulumi needs to deploy).
- **Mitigation**: Initial bootstrap is done locally once; subsequent updates are managed by the cloud engine.
