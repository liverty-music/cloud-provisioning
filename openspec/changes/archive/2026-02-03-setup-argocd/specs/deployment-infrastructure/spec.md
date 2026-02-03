## ADDED Requirements

### Requirement: Dedicated CD Namespace

The cluster SHALL support a dedicated namespace for Continuous Delivery tooling.

#### Scenario: Namespace Existence

- **WHEN** listing namespaces
- **THEN** a namespace named `argocd` (or configured equivalent) is present
