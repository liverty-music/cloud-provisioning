import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'

// Configuration constants moved from config module.
const DEFAULT_REGION = 'asia-northeast2'
const DEFAULT_ZONE = 'asia-northeast2-a'

const REQUIRED_APIS = [
  'cloudresourcemanager.googleapis.com',
  'serviceusage.googleapis.com',
  'iam.googleapis.com',
  'cloudbilling.googleapis.com',
  'compute.googleapis.com',
  'storage.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  'cloudtrace.googleapis.com',
  'discoveryengine.googleapis.com',
  'geminicloudassist.googleapis.com', // Required for Gemini Cloud Assist.
  'cloudasset.googleapis.com', // Recommended for Gemini Cloud Assist.
  'recommender.googleapis.com', // Recommended for Gemini Cloud Assist.
  'aiplatform.googleapis.com',
  'securitycenter.googleapis.com', // Correct endpoint for Security Command Center.
  'dataform.googleapis.com',
]

export interface GcpConfig {
  organizationId: string
  billingAccount: string
  geminiApiKey?: string
}

export interface GcpComponentArgs {
  brandId: string
  displayName: string
  environment: 'dev' | 'staging' | 'prod'
  gcpConfig: GcpConfig
  region?: string
  zone?: string
}

export class GcpProjectBasis extends pulumi.ComponentResource {
  public readonly folder: gcp.organizations.Folder | pulumi.Output<gcp.organizations.Folder>
  public readonly project: gcp.organizations.Project
  public readonly enabledServices: gcp.projects.Service[]
  // public readonly uverworldDataStore: gcp.discoveryengine.DataStore
  // public readonly uverworldSearchEngine: gcp.discoveryengine.SearchEngine
  public readonly environmentConfig: {
    environment: 'dev' | 'staging' | 'prod'
    projectId: string
    region: string
    zone?: string
    enabledApis: string[]
  }

  constructor(args: GcpComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:GcpProjectBasis', 'GcpProjectBasis', {}, opts)

    const { brandId, displayName, environment, gcpConfig, region, zone } = args

    // Initialize environment configuration.
    this.environmentConfig = this.createEnvironmentConfig(brandId, environment, region, zone)

    // Create organization folder.
    this.folder = this.createOrganizationFolder(brandId, displayName, environment, gcpConfig)

    // Create project.
    this.project = this.createProject(brandId, displayName, environment, gcpConfig)

    // Enable APIs.
    this.enabledServices = this.enableApis()

    // Register outputs.
    this.registerOutputs({
      folder: this.folder,
      project: this.project,
      enabledServices: this.enabledServices,
      environmentConfig: this.environmentConfig,
    })
  }

  private createEnvironmentConfig(
    brandId: string,
    environment: 'dev' | 'staging' | 'prod',
    region?: string,
    zone?: string
  ) {
    const config = new pulumi.Config()

    return {
      environment: environment,
      projectId: `${brandId}-${environment}`,
      region: region || config.get('region') || DEFAULT_REGION,
      zone: zone || config.get('zone'),
      enabledApis: [...REQUIRED_APIS],
    }
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
        projectId: this.environmentConfig.projectId,
        name: `${displayName} -${environment}-`,
        folderId: pulumi.output(this.folder).apply(folder => folder.folderId),
        billingAccount: gcpConfig.billingAccount,
        deletionPolicy: 'DELETE',
        labels: commonLabels,
      },
      { dependsOn: [this.folder] }
    )
  }

  private enableApis(): gcp.projects.Service[] {
    return this.environmentConfig.enabledApis.map(api => {
      const serviceName = api.replace(/\.googleapis\.com$/, '').replace(/\./g, '-')
      return new gcp.projects.Service(
        serviceName,
        {
          project: this.project.projectId,
          service: api,
          disableOnDestroy: true,
        },
        { dependsOn: [this.project] }
      )
    })
  }
}

// Export configuration utilities for external use if needed.
export { DEFAULT_REGION, DEFAULT_ZONE, REQUIRED_APIS }
