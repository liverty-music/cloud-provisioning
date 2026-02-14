
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
- **`src/index.ts`**: Main infrastructure entry point with organization folder, project, and service definitions
- **`src/config/`**: Configuration management
  - **`constants.ts`**: Project constants, folder names, and API service definitions
  - **`environments.ts`**: Environment-specific configuration logic and types
  - **`index.ts`**: Configuration exports
- **`src/components/`**: Reusable infrastructure components (organized by domain)
  - **`compute/`**: Compute resources (GCE, GKE, Cloud Functions)
  - **`networking/`**: VCP, subnets, firewall rules, load balancers
  - **`security/`**: IAM roles, service accounts, Secret Manager
  - **`storage/`**: Cloud Storage buckets, Cloud SQL, Firestore
- **`Pulumi.{env}.yaml`**: Stack-specific configurations for each environment
- **`.env`**: Environment variables for organization and billing account IDs
- **`.mise.toml`**: Node.js version management (v22)

### Configuration Management
- Use `pulumi config` for environment-specific values
- Always use `--secret` for sensitive configurations  
- Document required configurations in stack README

### Required Environment Variables
The following environment variables must be set in `.env`:
- **`GCP_ORGANIZATION_ID`**: Your GCP organization ID (required for folder and project creation)
- **`GCP_BILLING_ACCOUNT`**: Billing account ID for automatic project billing association

### Optional Pulumi Configuration
- **`region`**: GCP region (defaults to `us-central1` via DEFAULT_REGION constant)
- **`zone`**: Specific GCP zone within the region

## Security Guidelines

### Sensitive Data Handling
- NEVER hardcode secrets in infrastructure code
- Use `pulumi config set --secret` for sensitive values
- Leverage GCP Secret Manager for application secrets
- Use IAM roles instead of service account keys when possible

### GCP Best Practices
- Apply principle of least privilege for IAM roles
- Enable audit logging for critical resources
- Use VPC networks with appropriate firewall rules
- Implement resource tagging/labeling for cost management

## Operating Protocols

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

1. **Organization and Project Structure** (Current Implementation)
   - Create organization folders using descriptive names from FOLDER_NAME constant
   - Projects follow `{projectPrefix}-{environment}` naming pattern
   - Automatic billing account association via GCP_BILLING_ACCOUNT env var
   - Dependency management: services depend on projects, projects depend on folders

2. **Service Management** (Current Implementation)
   - Enable required APIs via enabledApis configuration in environment configs
   - Service names follow sanitized pattern (remove `.googleapis.com`, replace dots with hyphens)
   - Use `disableOnDestroy: true` for proper cleanup
   - Services depend on project creation

3. **Storage Resources** (Scaffold Ready)
   - Use consistent bucket naming conventions with environment prefixes
   - Apply appropriate lifecycle policies and versioning
   - Reference project.projectId for proper association

4. **Compute Resources** (Scaffold Ready)
   - Use managed instance groups for scalability in components/compute/
   - Implement health checks and resource labels
   - Leverage environment-specific configuration

5. **Networking** (Scaffold Ready)
   - Create dedicated VPCs per environment in components/networking/
   - Use firewall rules with specific source ranges
   - Implement network segmentation by environment

6. **IAM and Security** (Scaffold Ready)
   - Implement roles and service accounts in components/security/
   - Use Google Groups for role assignments
   - Enable audit logging for critical resources

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
