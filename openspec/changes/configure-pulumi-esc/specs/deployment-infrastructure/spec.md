## ADDED Requirements

### Requirement: Workload Identity Federation (WIF)

The infrastructure MUST establish a Workload Identity Pool specifically for external OIDC providers to allow keyless authentication from Pulumi Cloud.

#### Scenario: WIF Pool Provisioning

- **WHEN** the Pulumi stack is applied
- **THEN** a `WorkloadIdentityPool` named `external-providers` is created in the global location of the project.

### Requirement: Pulumi OIDC Provider

The system MUST configure an OIDC Provider within the Workload Identity Pool that trusts Pulumi Cloud as an issuer.

#### Scenario: OIDC Provider Configuration

- **WHEN** the Pulumi stack is applied
- **THEN** a `WorkloadIdentityPoolProvider` is created.
- **AND** it uses `https://api.pulumi.com/oidc` as the issuer.
- **AND** it allows audiences starting with `gcp:` followed by the Pulumi organization name.

### Requirement: Deployment Service Account

A dedicated GCP Service Account MUST be created to execute Pulumi deployments with restricted permissions.

#### Scenario: Service Account Assignment

- **WHEN** the Pulumi stack is applied
- **THEN** a `ServiceAccount` (e.g., `pulumi-cloud`) is created.
- **AND** it is granted the `roles/iam.workloadIdentityUser` role for the WIF provider.
- **AND** it is granted sufficient project-level roles (e.g., `roles/owner` or specific resource roles) to manage infrastructure.

### Requirement: Native Managed OIDC Deployment

The deployment process MUST use Pulumi Cloud Deployments' native OIDC integration with Google Cloud, following the [official documentation](https://www.pulumi.com/docs/deployments/deployments/oidc/gcp/).

#### Scenario: Keyless Managed Deployment

- **WHEN** a change is detected in the linked GitHub repository
- **THEN** Pulumi Cloud Deployments initiates a managed run.
- **AND** it automatically exchanges its OIDC token for a GCP service account token using the configured WIF details.
- **AND** the deployment proceeds without requiring long-lived secrets.

### Requirement: Automated PR Flow

Pulumi Cloud MUST trigger specific actions for `dev` and `prod` stacks when a Pull Request is opened or updated.

#### Scenario: Dev Auto-Deploy on PR

- **WHEN** a developer opens or updates a Pull Request targeting `main`
- **THEN** Pulumi Cloud Deployments MUST automatically trigger an `up` for the `dev` stack.

#### Scenario: Prod Preview on PR

- **WHEN** a developer opens or updates a Pull Request targeting `main`
- **THEN** Pulumi Cloud Deployments MUST automatically trigger a `preview` for the `prod` stack.
- **AND** the results MUST be posted as a comment on the GitHub PR.

### Requirement: Automated Merge Flow

Pulumi Cloud MUST automatically apply changes to the production environment when code is merged into the `main` branch.

#### Scenario: Prod Deploy on Merge

- **WHEN** a Pull Request is merged into the `main` branch
- **THEN** Pulumi Cloud Deployments MUST automatically trigger an `up` for the `prod` stack.
