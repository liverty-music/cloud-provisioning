import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import { ProjectComponent, GcpConfig } from './components/project.js'
import { IamService } from './services/iam.js'
import { WorkloadIdentityComponent } from './components/workload-identity.js'
import { ConcertDataStore } from './components/concert-data-store.js'
import { NetworkComponent } from './components/network.js'
import { KubernetesComponent } from './components/kubernetes.js'
import { PostgresComponent } from './components/postgres.js'
import { RegionNames, Regions } from './region.js'

export interface GcpArgs {
  brandId: string
  displayName: string
  environment: 'dev' | 'staging' | 'prod'
  gcpConfig: GcpConfig
}

export const NetworkConfig = {
  Osaka: {
    // Primary range for GKE Nodes + PSC Endpoints
    subnetCidr: '10.10.0.0/20',
    // Secondary ranges for GKE
    podsCidr: '10.20.0.0/16',
    servicesCidr: '10.30.0.0/20',
    // GKE Control Plane CIDR
    masterCidr: '172.16.0.0/28',
    // Target IP for Cloud SQL PSC Endpoint
    postgresPscIp: '10.10.10.10',
  },
} as const

/**
 * Gcp orchestrates all GCP resources.
 * It is a plain class (not a ComponentResource) to keep the resource URNs flat.
 */
export class Gcp {
  public readonly folder: gcp.organizations.Folder | pulumi.Output<gcp.organizations.Folder>
  public readonly project: gcp.organizations.Project
  public readonly projectId: pulumi.Output<string>
  public readonly region: string = Regions.Osaka
  public readonly githubActionsSAEmail: pulumi.Output<string>
  public readonly githubWorkloadIdentityProvider: pulumi.Output<string>

  constructor(args: GcpArgs) {
    const { brandId, displayName, environment, gcpConfig } = args

    // 1. Project and Folders
    const projectBasis = new ProjectComponent({
      brandId,
      displayName,
      environment,
      gcpConfig,
    })
    this.folder = projectBasis.folder
    this.project = projectBasis.project
    this.projectId = this.project.projectId

    const lm = 'liverty-music'
    const backendApp = 'backend-app'
    const namespace = 'backend'

    // 2. Identity Management (GSA + Workload Identity)
    const iamSvc = new IamService(this.project)
    const backendAppSA = iamSvc.createServiceAccount(
      `${lm}-${backendApp}`,
      backendApp,
      'Liverty Music Backend Application Service Account',
      'Service account for backend application'
    )

    // 3. Network (VPC, Subnets, NAT) - Osaka
    const network = new NetworkComponent('network', {
      region: Regions.Osaka,
      regionName: RegionNames.Osaka,
      project: this.project,
    })

    // 4. Concert Data Store (Vertex AI Search)
    new ConcertDataStore({
      project: this.project,
      region: Regions.Osaka,
    })

    // 5. GKE Autopilot Cluster
    const osakaConfig = NetworkConfig.Osaka
    const kubernetes = new KubernetesComponent('kubernetes-cluster', {
      project: this.project,
      environment,
      region: Regions.Osaka,
      regionName: RegionNames.Osaka,
      networkId: network.network.id,
      subnetCidr: osakaConfig.subnetCidr,
      podsCidr: osakaConfig.podsCidr,
      servicesCidr: osakaConfig.servicesCidr,
      masterCidr: osakaConfig.masterCidr,
    })

    // 6. Bind Workload Identity (allow GKE KSA to impersonate GSA)
    // Requires GKE API (enabled in KubernetesComponent)
    new gcp.serviceaccount.IAMMember(
      `${backendApp}-wif-binding`,
      {
        serviceAccountId: backendAppSA.name,
        role: 'roles/iam.workloadIdentityUser',
        member: pulumi.interpolate`principal://iam.googleapis.com/projects/${this.project.number}/locations/global/workloadIdentityPools/${this.project.projectId}.svc.id.goog/subject/ns/${namespace}/sa/${backendApp}`,
      },
      { dependsOn: [kubernetes] }
    )

    // 7. Cloud SQL Instance (Postgres)
    new PostgresComponent('postgres', {
      project: this.project,
      region: Regions.Osaka,
      regionName: RegionNames.Osaka,
      environment,
      subnetId: kubernetes.subnet.id,
      networkId: network.network.id,
      pscEndpointIp: osakaConfig.postgresPscIp,
      dnsZoneName: network.pscZone.name,
      appServiceAccountEmail: backendAppSA.email,
    })

    // 8. Artifact Registry
    const artifactRegistry = new gcp.artifactregistry.Repository(
      'github-backend-repository',
      {
        repositoryId: 'backend',
        location: Regions.Osaka,
        format: 'DOCKER',
        project: this.project.projectId,
        description: 'Docker repository for GitHub Backend Repository',
      },
      { parent: this.project }
    )

    // Grant backend-app SA permission to pull images from Artifact Registry
    iamSvc.bindArtifactRegistryReader(
      backendApp,
      backendAppSA.email,
      artifactRegistry,
      Regions.Osaka,
      artifactRegistry
    )

    // 9. Workload Identity Federation
    const wif = new WorkloadIdentityComponent({
      environment,
      folder: this.folder,
      project: this.project,
    })
    this.githubWorkloadIdentityProvider = wif.githubProvider.name
    this.githubActionsSAEmail = wif.githubActionsSA.email
  }
}
