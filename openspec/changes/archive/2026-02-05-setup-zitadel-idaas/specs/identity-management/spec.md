## ADDED Requirements

### Requirement: Manage Zitadel Organization

The system SHALL manage the Zitadel organization configuration via Infrastructure as Code to ensure consistency and reproducibility.

#### Scenario: Provision Organization

- **WHEN** Pulumi stack is applied
- **THEN** the Zitadel organization defined in the configuration SHALL exist

### Requirement: Manage Zitadel Project

The system SHALL manage the `liverty-music` project within the Zitadel organization to group related resources.

#### Scenario: Provision Project

- **WHEN** Pulumi stack is applied
- **THEN** a project named `liverty-music` SHALL exist in the organization

### Requirement: Manage OIDC Application

The system SHALL manage the OIDC application for the frontend SPA within the `liverty-music` project to enable user authentication.

#### Scenario: Provision OIDC App

- **WHEN** Pulumi stack is applied
- **THEN** an OIDC application named `liverty-music` SHALL exist
- **AND** the application Type SHALL be "SPA"
- **AND** the Auth Method Type SHALL be "NONE"

### Requirement: Configure Login Policy

The system SHALL establish a login policy that enables passwordless authentication to improve user experience and security.

#### Scenario: Apply Login Policy

- **WHEN** Pulumi stack is applied
- **THEN** the default login policy for the organization SHALL be configured
- **AND** `PasswordlessType` SHALL be "ALLOWED"
- **AND** `IgnorePasswordComplexity` SHALL be true
- **AND** `UserLogin` SHALL be true
