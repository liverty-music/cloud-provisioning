import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'

export interface ConcertDataStoreArgs {
  projectId: pulumi.Input<string>
  projectNumber: pulumi.Input<string>
  region: pulumi.Input<string>
  enabledServices: pulumi.Input<gcp.projects.Service>[]
}

export class ConcertDataStore extends pulumi.ComponentResource {
  constructor(args: ConcertDataStoreArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:ConcertDataStore', 'ConcertDataStore', args, opts)

    const { projectId, projectNumber, region, enabledServices } = args

    this.createUverworldDataStore(projectId, projectNumber, region, enabledServices)
  }

  private createUverworldDataStore(
    projectId: pulumi.Input<string>,
    projectNumber: pulumi.Input<string>,
    region: pulumi.Input<string>,
    enabledServices: pulumi.Input<gcp.projects.Service>[]
  ) {
    const webSiteStore = new gcp.discoveryengine.DataStore(
      'official-artist-site',
      {
        location: 'global',
        dataStoreId: 'official-artist-site',
        displayName: 'Official Artist Site',
        industryVertical: 'GENERIC',
        contentConfig: 'PUBLIC_WEBSITE',
        solutionTypes: ['SOLUTION_TYPE_SEARCH'],
        createAdvancedSiteSearch: true, // Required for Extractive Segments
        advancedSiteSearchConfig: {
          disableAutomaticRefresh: false,
          disableInitialIndex: false,
        },
        skipDefaultSchemaCreation: false,
        project: projectId,
      },
      { dependsOn: enabledServices }
    )

    // Set the target site for the data store to crawl.
    new gcp.discoveryengine.TargetSite(
      'uverworld-target-site',
      {
        location: webSiteStore.location,
        dataStoreId: webSiteStore.dataStoreId,
        providedUriPattern: 'www.uverworld.jp/*',
        type: 'INCLUDE',
        exactMatch: false,
        project: projectId,
      },
      { dependsOn: [webSiteStore] }
    )

    // Create a search engine for official artist website.
    const searchEngine = new gcp.discoveryengine.SearchEngine(
      'artist-site-search',
      {
        engineId: 'artist-site-search',
        location: webSiteStore.location,
        collectionId: 'default_collection',
        displayName: 'Official Artist Site Search',
        industryVertical: 'GENERIC',
        dataStoreIds: [webSiteStore.dataStoreId],
        searchEngineConfig: {
          searchTier: 'SEARCH_TIER_ENTERPRISE',
          searchAddOns: ['SEARCH_ADD_ON_LLM'], // enable generative AI integration
        },
        project: projectId,
      },
      { dependsOn: [webSiteStore] }
    )

    // Grant Vertex AI Service Agent permission to read Discovery Engine
    new gcp.projects.IAMMember(
      'vertex-ai-discoveryengine-viewer',
      {
        project: projectId,
        role: 'roles/discoveryengine.viewer',
        member: pulumi.interpolate`serviceAccount:service-${projectNumber}@gcp-sa-aiplatform.iam.gserviceaccount.com`,
      },
      { dependsOn: [searchEngine] }
    )

    return { dataStore: webSiteStore, searchEngine }
  }
}
