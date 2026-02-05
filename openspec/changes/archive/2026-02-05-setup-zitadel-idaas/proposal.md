## Why

To handle user authentication and identity management securely and centrally for the Liverty Music platform. Setting up Zitadel as the IDaaS provider via Pulumi ensures reproducible infrastructure and managed identity services.

## What Changes

- Configure the Zitadel Pulumi provider.
- Create a Zitadel Project named `liverty-music`.
- Create an OIDC Application within the project for the frontend SPA.
- Configure default Login Policy to allow passwordless authentication and ignore password complexity.

## Capabilities

### New Capabilities

- `identity-management`: Setup of Zitadel organization, project, and OIDC application for user authentication.

### Modified Capabilities

<!-- No existing capabilities are being modified at the spec level. -->

## Impact

- **Infrastructure**: New Pulumi resources for Zitadel in `cloud-provisioning`.
- **Security**: Centralized user management and authentication flow.
