# Change: Provision WIF and Configure Pulumi Cloud Deployments

## Why

To enable secure, fully managed infrastructure deployments using **Pulumi Cloud Deployments**. This transition requires two phases:

1. Provisioning the necessary GCP Workload Identity Federation (WIF) resources.
2. Configuring Pulumi Cloud's native OIDC integration to use those resources for keyless authentication.

This follows official best practices for secure, keyless GCP deployments.

## What Changes

- **Implement GCP WIF Infrastructure**: Define and provision `WorkloadIdentityPool`, `WorkloadIdentityPoolProvider`, and `ServiceAccount` using Pulumi.
- **Enable Pulumi Cloud Deployments**: Configure `dev` and `prod` stacks for managed execution in the Pulumi Console.
- **Configure Native OIDC Settings**: Register the newly created WIF details in the Pulumi Console's "Deploy" settings.
- **Set up Deployment Triggers**: Integration with GitHub via the Pulumi GitHub App.

## Impact

- Affected specs: `deployment-infrastructure` (NEW)
- Affected code: `src/components/gcp/workload-identity.ts`, `src/index.ts`, `.github/workflows/pulumi-*.yml`.
