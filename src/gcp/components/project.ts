import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { ApiService } from '../services/api.js'

export interface GcpConfig {
  organizationId: string
  billingAccount: string
  geminiApiKey?: string
}

export interface ProjectComponentArgs {
  brandId: string
  displayName: string
  environment: 'dev' | 'staging' | 'prod'
  gcpConfig: GcpConfig
}

export class ProjectComponent extends pulumi.ComponentResource {
  public readonly folder: gcp.organizations.Folder | pulumi.Output<gcp.organizations.Folder>
  public readonly project: gcp.organizations.Project

  constructor(args: ProjectComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:GcpProjectBasis', 'GcpProjectBasis', {}, opts)

    const { brandId, displayName, environment, gcpConfig } = args

    // Create organization folder.
    this.folder = this.createOrganizationFolder(brandId, displayName, environment, gcpConfig)

    // Create project.
    this.project = this.createProject(brandId, displayName, environment, gcpConfig)

    // Enable APIs.
    const apiService = new ApiService(this.project.projectId)
    apiService.enableApis([
      'cloudresourcemanager.googleapis.com', // Required for folder creation.
      'serviceusage.googleapis.com', // Required for API enablement.
      'iam.googleapis.com', // Required for service account creation.
      'cloudbilling.googleapis.com', // Required for billing.
      'securitycenter.googleapis.com', // Required for security center.
      'compute.googleapis.com', // Required for VPC and subnets.
      'storage.googleapis.com', // Required for storage.
      'logging.googleapis.com', // Required for logging.
      'monitoring.googleapis.com', // Required for monitoring.
      'cloudtrace.googleapis.com', // Required for tracing.
      'geminicloudassist.googleapis.com', // Required for Gemini Cloud Assist.
      'cloudasset.googleapis.com', // Recommended for Gemini Cloud Assist.
      'recommender.googleapis.com', // Recommended for Gemini Cloud Assist.
    ])

    // Register outputs.
    this.registerOutputs({
      folder: this.folder,
      project: this.project,
    })
  }

  private createOrganizationFolder(
    brandId: string,
    displayName: string,
    environment: 'dev' | 'staging' | 'prod',
    gcpConfig: GcpConfig
  ): gcp.organizations.Folder | pulumi.Output<gcp.organizations.Folder> {
    if (environment === 'prod') {
      return new gcp.organizations.Folder(brandId, {
        displayName: displayName,
        parent: `organizations/${gcpConfig.organizationId}`,
      })
    } else {
      // For non-prod environments, reference the folder created in the prod stack.
      // This requires the prod stack to export its folder.
      const org = pulumi.getOrganization()
      const project = pulumi.getProject()
      // Construct the fully qualified name of the prod stack.
      const prodStackRef = new pulumi.StackReference(`${org}/${project}/prod`)
      const folderOutput = prodStackRef.requireOutput('folder')

      // Use Output.all to properly handle the async folder ID.
      return pulumi
        .output(folderOutput)
        .apply(folder => gcp.organizations.Folder.get(brandId, folder.id))
    }
  }

  private createProject(
    brandId: string,
    displayName: string,
    environment: 'dev' | 'staging' | 'prod',
    gcpConfig: GcpConfig
  ): gcp.organizations.Project {
    // Common labels for resources.
    const commonLabels = {
      environment: environment,
    }

    return new gcp.organizations.Project(
      `${brandId}`,
      {
        projectId: `${brandId}-${environment}`,
        name: `${displayName} -${environment}-`,
        folderId: pulumi.output(this.folder).apply(folder => folder.folderId),
        billingAccount: gcpConfig.billingAccount,
        deletionPolicy: 'ABANDON',
        labels: commonLabels,
      },
      { dependsOn: [this.folder] }
    )
  }
}
