import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import { ApiService } from '../services/api.js'

export interface ConcertDataStoreArgs {
  projectId: pulumi.Input<string>
  projectNumber: pulumi.Input<string>
  region: pulumi.Input<string>
}

export class ConcertDataStore extends pulumi.ComponentResource {
  constructor(args: ConcertDataStoreArgs, opts?: pulumi.ComponentResourceOptions) {
    super('gcp:liverty-music:ConcertDataStore', 'ConcertDataStore', args, opts)

    const { projectId, projectNumber } = args

    const apiService = new ApiService(projectId)
    const enabledApis = apiService.enableApis([
      'discoveryengine.googleapis.com', // Required for Discovery Engine
      'aiplatform.googleapis.com', // Required for AI Platform
    ])

    this.createUverworldDataStore(projectId, projectNumber, enabledApis)
  }

  private createUverworldDataStore(
    projectId: pulumi.Input<string>,
    projectNumber: pulumi.Input<string>,
    enabledApis: pulumi.Input<gcp.projects.Service>[]
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
        skipDefaultSchemaCreation: false,
        project: projectId,
      },
      { ignoreChanges: ['advancedSiteSearchConfig'] }
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
      { dependsOn: enabledApis }
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
