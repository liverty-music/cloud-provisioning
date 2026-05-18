import * as gcp from '@pulumi/gcp'
import type * as pulumi from '@pulumi/pulumi'
import type { Environment } from '../../config.js'
import { toKebabCase } from '../../lib/lib.js'

export type GoogleApis =
	| 'cloudresourcemanager.googleapis.com'
	| 'serviceusage.googleapis.com'
	| 'iam.googleapis.com'
	| 'cloudbilling.googleapis.com'
	| 'billingbudgets.googleapis.com'
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
	| 'clouderrorreporting.googleapis.com'
	| 'places.googleapis.com'
	| 'cloudkms.googleapis.com'
	| 'certificatemanager.googleapis.com'

export class ApiService {
	constructor(
		private project: gcp.organizations.Project,
		private environment: Environment,
	) {}

	enableApis(
		apis: GoogleApis[],
		parent?: pulumi.Resource,
	): gcp.projects.Service[] {
		// `disableOnDestroy` is environment-conditional:
		//   - dev: `false` — the dev shutdown cycle destroys and recreates
		//     the workload tier repeatedly. API enable is free; flipping
		//     the toggle adds re-enable latency on every restart and breaks
		//     out-of-band tooling that depends on the API during the
		//     destroy/recreate window.
		//   - prod / future envs: `true` — when prod is eventually
		//     decommissioned, Pulumi destroy needs to flip the APIs off so
		//     `gcloud projects delete` succeeds without a manual
		//     `gcloud services disable` pass. The destroy-rebuild churn
		//     that motivates `false` in dev does not happen in prod.
		const disableOnDestroy = this.environment !== 'dev'
		return apis.map((api) => {
			const apiName = toKebabCase(api.replace(/\.googleapis\.com$/, ''))
			return new gcp.projects.Service(
				apiName,
				{
					project: this.project.projectId,
					service: api,
					disableOnDestroy,
				},
				{ parent },
			)
		})
	}
}
