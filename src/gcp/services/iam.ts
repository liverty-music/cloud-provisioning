import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import { toKebabCase } from '../../lib/lib.js'

export const Roles = {
	Project: {
		Owner: 'roles/owner',
	},
	ResourceManager: {
		FolderViewer: 'roles/resourcemanager.folderViewer',
	},
	CloudSql: {
		Client: 'roles/cloudsql.client',
		InstanceUser: 'roles/cloudsql.instanceUser',
	},
	Logging: {
		LogWriter: 'roles/logging.logWriter',
	},
	Monitoring: {
		MetricWriter: 'roles/monitoring.metricWriter',
		Viewer: 'roles/monitoring.viewer',
	},
	Stackdriver: {
		ResourceMetadataWriter: 'roles/stackdriver.resourceMetadata.writer',
	},
	CloudTrace: {
		Agent: 'roles/cloudtrace.agent',
	},
	DiscoveryEngine: {
		Viewer: 'roles/discoveryengine.viewer',
	},
	AiPlatform: {
		User: 'roles/aiplatform.user',
	},
	ArtifactRegistry: {
		Reader: 'roles/artifactregistry.reader',
		Writer: 'roles/artifactregistry.writer',
	},
} as const

type DeepValueOf<T> = T extends object
	? { [K in keyof T]: DeepValueOf<T[K]> }[keyof T]
	: T
export type IamRole = DeepValueOf<typeof Roles>

export class IamService {
	constructor(private project: gcp.organizations.Project) {}

	createServiceAccount(
		name: string,
		saName: string,
		displayName: string,
		description: string,
		parent?: pulumi.Resource,
	) {
		return new gcp.serviceaccount.Account(
			name,
			{
				accountId: saName,
				displayName,
				description,
				project: this.project.projectId,
			},
			{ parent },
		)
	}

	bindProjectRoles(
		roles: IamRole[],
		saName: string,
		saEmail: pulumi.Input<string>,
		parent?: pulumi.Resource,
	): gcp.projects.IAMMember[] {
		return roles.map((role) => {
			return new gcp.projects.IAMMember(
				`${saName}-x-${toKebabCase(role.split('/').pop() ?? 'unknown')}`,
				{
					project: this.project.projectId,
					role,
					member: pulumi.interpolate`serviceAccount:${saEmail}`,
				},
				{ parent },
			)
		})
	}

	bindFolderRoles(
		roles: IamRole[],
		saName: string,
		saEmail: pulumi.Input<string>,
		folder:
			| gcp.organizations.Folder
			| pulumi.Output<gcp.organizations.Folder>,
		parent?: pulumi.Resource,
	): gcp.folder.IAMMember[] {
		return roles.map((role) => {
			return new gcp.folder.IAMMember(
				`${saName}-x-${toKebabCase(role.split('/').pop() ?? 'unknown')}`,
				{
					folder: folder.folderId,
					role,
					member: pulumi.interpolate`serviceAccount:${saEmail}`,
				},
				{ parent },
			)
		})
	}

	bindWifUser(
		name: string,
		externalMember: string,
		sa: gcp.serviceaccount.Account,
		pool: gcp.iam.WorkloadIdentityPool,
		parent?: pulumi.Resource,
	) {
		return new gcp.serviceaccount.IAMMember(
			`${name}-wif-user`,
			{
				serviceAccountId: sa.name,
				role: 'roles/iam.workloadIdentityUser',
				member: pulumi.interpolate`principalSet://iam.googleapis.com/projects/${this.project.number}/locations/global/workloadIdentityPools/${pool.workloadIdentityPoolId}/${externalMember}`,
			},
			{ parent },
		)
	}

	bindKubernetesSaUser(
		name: string,
		sa: gcp.serviceaccount.Account,
		namespace: string,
		parent?: pulumi.Resource,
	) {
		return new gcp.serviceaccount.IAMMember(
			`${name}-k8s-sa-wif-user`,
			{
				serviceAccountId: sa.name,
				role: 'roles/iam.workloadIdentityUser',
				member: pulumi.interpolate`principal://iam.googleapis.com/projects/${this.project.number}/locations/global/workloadIdentityPools/${this.project.projectId}.svc.id.goog/subject/ns/${namespace}/sa/${name}`,
			},
			{ parent },
		)
	}

	bindArtifactRegistryReader(
		name: string,
		saEmail: pulumi.Input<string>,
		repository: gcp.artifactregistry.Repository,
		location: string,
		parent?: pulumi.Resource,
	) {
		return new gcp.artifactregistry.RepositoryIamMember(
			`${name}-x-artifact-registry-reader`,
			{
				repository: repository.name,
				location,
				project: this.project.projectId,
				role: Roles.ArtifactRegistry.Reader,
				member: pulumi.interpolate`serviceAccount:${saEmail}`,
			},
			{ parent },
		)
	}
}
