import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'

export interface GcpConfig {
  organizationId: string
  billingAccount: string
}

export interface GcpComponentArgs {
  brandId: string
  displayName: string
  environment: 'dev' | 'staging' | 'prod'
  gcpConfig: GcpConfig
  enabledApis: readonly string[]
}

export class GcpComponent extends pulumi.ComponentResource {
  public readonly folder: gcp.organizations.Folder | pulumi.Output<gcp.organizations.Folder>
  public readonly project: gcp.organizations.Project
  public readonly enabledServices: gcp.projects.Service[]
  public readonly uverworldDataStore: gcp.discoveryengine.DataStore
  public readonly uverworldSearchEngine: gcp.discoveryengine.SearchEngine

  constructor(args: GcpComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('GCP', 'gcp', {}, opts)

    const { brandId, displayName, environment, gcpConfig, enabledApis } = args

    // Create organization folder
    if (environment === 'prod') {
      this.folder = new gcp.organizations.Folder(brandId, {
        displayName: displayName,
        parent: `organizations/${gcpConfig.organizationId}`,
      })
    } else {
      // For non-prod environments, reference the folder created in the prod stack.
      // This requires the prod stack to export its folder.
      const org = pulumi.getOrganization()
      const project = pulumi.getProject()
      // Construct the fully qualified name of the prod stack
      const prodStackRef = new pulumi.StackReference(`${org}/${project}/prod`)
      const folderOutput = prodStackRef.requireOutput('folder')

      // Use Output.all to properly handle the async folder ID
      this.folder = pulumi
        .output(folderOutput)
        .apply(folder => gcp.organizations.Folder.get(brandId, folder.id))
    }

    // Common labels for resources
    const commonLabels = {
      environment: environment,
    }

    // Create project
    this.project = new gcp.organizations.Project(
      `${brandId}`,
      {
        projectId: `${brandId}-${environment}`,
        name: `${displayName} -${environment}-`,
        folderId: pulumi.output(this.folder).apply(folder => folder.folderId),
        billingAccount: gcpConfig.billingAccount,
        deletionPolicy: 'DELETE',
        labels: commonLabels,
      },
      { dependsOn: [this.folder] }
    )

    // Enable APIs
    this.enabledServices = enabledApis.map(api => {
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

    const { dataStore, searchEngine } = this.createUverworldDataStore()
    this.uverworldDataStore = dataStore
    this.uverworldSearchEngine = searchEngine

    // Register outputs
    this.registerOutputs({
      folder: this.folder,
      project: this.project,
      enabledServices: this.enabledServices,
      uverworldDataStore: this.uverworldDataStore,
      uverworldSearchEngine: this.uverworldSearchEngine,
    })
  }

  private createUverworldDataStore() {
    const dataStore = new gcp.discoveryengine.DataStore(
      'uverworld-live-schedule-data-store',
      {
        location: 'global',
        dataStoreId: 'uverworld-live-schedule-data-store',
        displayName: 'UVERworld Live Schedule Data Store',
        industryVertical: 'GENERIC',
        contentConfig: 'PUBLIC_WEBSITE',
        solutionTypes: ['SOLUTION_TYPE_SEARCH'],
        createAdvancedSiteSearch: false,
        skipDefaultSchemaCreation: false,
        project: this.project.projectId,
      },
      { dependsOn: this.enabledServices }
    )

    // Set the target site for the data store to crawl
    new gcp.discoveryengine.TargetSite(
      'uverworld-target-site',
      {
        location: dataStore.location,
        dataStoreId: dataStore.dataStoreId,
        providedUriPattern: 'www.uverworld.jp/*',
        type: 'INCLUDE',
        exactMatch: false,
        project: this.project.projectId,
      },
      { dependsOn: [dataStore] }
    )

    // Create a search engine for the UVERworld website
    const searchEngine = new gcp.discoveryengine.SearchEngine(
      'uverworld-search-engine',
      {
        engineId: 'uverworld-search-engine',
        location: dataStore.location,
        collectionId: 'default_collection',
        displayName: 'UVERworld Live Schedule Search',
        industryVertical: 'GENERIC',
        dataStoreIds: [dataStore.dataStoreId],
        searchEngineConfig: {
          searchTier: 'SEARCH_TIER_STANDARD',
          searchAddOns: ['SEARCH_ADD_ON_LLM'],
        },
        project: this.project.projectId,
      },
      { dependsOn: [dataStore] }
    )

    return { dataStore, searchEngine }
  }
}
