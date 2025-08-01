# Public Cloud Scaffold

A comprehensive GCP infrastructure scaffold using Pulumi and TypeScript. This scaffold provides a production-ready foundation for managing GCP organizations, projects, and services across multiple environments.

## Overview

This scaffold creates and manages GCP organizational resources including folders, projects, and enabled services. It supports multi-environment deployments (dev/staging/prod) with proper configuration management and infrastructure as code best practices.

## Providers

- `@pulumi/pulumi`
- `@pulumi/gcp`

## Resources Created

- **Organization Folder** (`gcp.organizations.Folder`) - Organizational folder for project grouping
- **GCP Project** (`gcp.organizations.Project`) - Environment-specific projects with billing
- **Enabled Services** (`gcp.projects.Service`) - Required GCP APIs for each environment

## Outputs

- `folder` – The created organization folder
- `project` – The GCP project with configured billing
- `enabledServices` – List of enabled GCP services

## When to Use

Use this scaffold when you:
- Need to set up GCP organization and project structure with proper governance
- Want a production-ready foundation for multi-environment infrastructure
- Require consistent project setup across development, staging, and production
- Need proper billing account association and service enablement automation

## Prerequisites

- **Node.js 22+** (managed via mise toolchain)
- **Pulumi CLI** installed and configured
- **GCP Organization** with billing account access
- **Organization Admin** permissions for folder and project creation
- **GCP credentials** configured (via `gcloud auth application-default login`)
- **Environment variables** set (see Configuration section)

## Getting Started

1. **Clone this repository:**
   ```bash
   git clone <repository-url>
   cd public-cloud-scaffold
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your GCP organization and billing account IDs
   ```

4. **Initialize Pulumi stacks:**
   ```bash
   # Create and configure each environment
   pulumi stack init dev
   pulumi stack init staging
   pulumi stack init prod
   ```

## Project Layout

```
.
├── .env.example                  # Environment variables template
├── .mise.toml                   # Mise toolchain configuration (Node.js 22)
├── Pulumi.yaml                  # Pulumi project definition
├── Pulumi.{dev,staging,prod}.yaml # Stack-specific configurations
├── package.json                 # Node.js dependencies and scripts
├── tsconfig.json               # TypeScript compiler configuration
├── eslint.config.mjs           # ESLint configuration
├── CLAUDE.md                   # AI assistant project instructions
└── src/
    ├── index.ts                # Main infrastructure entry point
    ├── config/
    │   ├── index.ts            # Configuration exports
    │   ├── constants.ts        # Project constants and API definitions
    │   └── environments.ts     # Environment-specific configurations
    └── components/             # Reusable infrastructure components
        ├── compute/            # Compute resources (VMs, GKE, etc.)
        ├── networking/         # VPC, subnets, firewall rules
        ├── security/           # IAM, secrets, policies
        └── storage/            # Cloud Storage, databases
```

## Configuration

### Environment Variables (.env)

Required environment variables that must be set:

- `GCP_ORGANIZATION_ID` – Your GCP organization ID
- `GCP_BILLING_ACCOUNT` – Billing account ID for project association

### Pulumi Configuration

Optional stack configuration values:

- `region` – GCP region (defaults to `us-central1`)
- `zone` – GCP zone within the region

Set configuration values:
```bash
# Set custom region
pulumi config set region us-west2

# Set specific zone
pulumi config set zone us-west2-a
```

### Stack Management

Switch between environments:
```bash
pulumi stack select dev       # Development environment
pulumi stack select staging   # Staging environment  
pulumi stack select prod      # Production environment
```

## Development

### Available Scripts

- `npm run lint` – Lint TypeScript code with ESLint
- `npm run lint:fix` – Auto-fix linting issues
- `npm run format` – Format code with Prettier
- `npm run format:check` – Check code formatting
- `npm run typecheck` – Run TypeScript type checking
- `npm run build` – Compile TypeScript to JavaScript
- `npm run dev` – Watch mode for development

### Mise Toolchain

This project uses [mise](https://github.com/jdx/mise) for tool version management:

```bash
# Install mise (if not already installed)
curl https://mise.run | sh

# Install the configured Node.js version
mise install

# Node.js 22 will be automatically available
node --version
```

## Next Steps

- **Add infrastructure components** in the `src/components/` directories
- **Configure additional GCP APIs** in `src/config/constants.ts`
- **Implement networking resources** (VPCs, subnets, firewall rules)
- **Set up compute resources** (GCE instances, GKE clusters)
- **Configure storage solutions** (Cloud Storage, Cloud SQL)
- **Implement security policies** (IAM roles, service accounts)

## Resources

- [Pulumi GCP Provider Documentation](https://www.pulumi.com/docs/reference/pkg/gcp/)
- [GCP Architecture Center](https://cloud.google.com/architecture)
- [Pulumi TypeScript Guide](https://www.pulumi.com/docs/get-started/typescript/)

## Getting Help

If you run into issues or have questions, check out:
- Pulumi Documentation: https://www.pulumi.com/docs/
- Community Slack: https://slack.pulumi.com/
- GitHub Issues: https://github.com/pulumi/pulumi/issues