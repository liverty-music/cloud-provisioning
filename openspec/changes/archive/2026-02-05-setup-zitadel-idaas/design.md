## Context

Liverty Music requires a centralized identity management solution. We have chosen Zitadel for this purpose. Currently, the default organization `liverty-music` exists, but downstream resources like projects and applications need to be managed. We will use Pulumi to define these resources as Infrastructure as Code.

## Goals / Non-Goals

**Goals:**

- Manage Zitadel Project `liverty-music` via Pulumi.
- Manage OIDC Application for the frontend via Pulumi.
- Configure Login Policy for passwordless access via Pulumi.
- Use the existing machine user credentials for Pulumi authentication against Zitadel.

**Non-Goals:**

- Managing the Zitadel instance itself (we assume it's running and accessible).
- Managing the default organization creation (already exists).

## Decisions

### Use `pulumiservice` for Zitadel Provider Configuration

**Decision:** We will configure the Zitadel provider using the service account key provided.
**Rationale:** This allows Pulumi to authenticate as the machine user with `IAM Owner` permissions to manage resources within the organization.

### Manage Resources in `cloud-provisioning`

**Decision:** All Zitadel resources will be defined in the `cloud-provisioning` repository.
**Rationale:** This centralizes all infrastructure definitions (GCP, GitHub, Zitadel) in one place.

### Resource Hierarchy

**Decision:**

1.  **Project**: `zitadel.Project` resource named `liverty-music`.
2.  **Application**: `zitadel.ApplicationOidc` resource attached to the project.
3.  **Login Policy**: `zitadel.LoginPolicy` resource attached to the organization (or project if more granular control is needed, but org-level is sufficient for now).

## Risks / Trade-offs

- **Risk**: Secret management for the service key.
  - **Mitigation**: The key is stored as a Pulumi secret configuration (`zitadel:pulumiUserKey`).
- **Risk**: State drift if modifications are made in the Zitadel Console.
  - **Mitigation**: Strictly discourage manual changes; all changes must go through Pulumi.

## Open Questions

- None at this stage.
