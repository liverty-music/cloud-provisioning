import * as gcp from '@pulumi/gcp'
import type * as pulumi from '@pulumi/pulumi'
import { toKebabCase } from '../../lib/lib.js'

export type GoogleApis =
	| 'cloudresourcemanager.googleapis.com'
	| 'serviceusage.googleapis.com'
	| 'iam.googleapis.com'
	| 'cloudbilling.googleapis.com'
	| 'compute.googleapis.com'
	| 'storage.googleapis.com'
	| 'logging.googleapis.com'
	| 'monitoring.googleapis.com'
	| 'cloudtrace.googleapis.com'
	| 'discoveryengine.googleapis.com'
	| 'geminicloudassist.googleapis.com'
	| 'cloudasset.googleapis.com'
	| 'recommender.googleapis.com'
	| 'aiplatform.googleapis.com'
	| 'securitycenter.googleapis.com'
	| 'dataform.googleapis.com'
	| 'sqladmin.googleapis.com'
	| 'servicenetworking.googleapis.com'
	| 'container.googleapis.com'
	| 'dns.googleapis.com'
	| 'artifactregistry.googleapis.com'
	| 'secretmanager.googleapis.com'

export class ApiService {
	constructor(private project: gcp.organizations.Project) {}

	enableApis(
		apis: GoogleApis[],
		parent?: pulumi.Resource,
	): gcp.projects.Service[] {
		return apis.map((api) => {
			const apiName = toKebabCase(api.replace(/\.googleapis\.com$/, ''))
			return new gcp.projects.Service(
				apiName,
				{
					project: this.project.projectId,
					service: api,
					disableOnDestroy: true,
				},
				{ parent },
			)
		})
	}
}
