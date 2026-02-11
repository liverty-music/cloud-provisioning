import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../config.js'
import { FrontendComponent } from './components/frontend.js'

export * from './components/frontend.js'

export interface ZitadelConfig {
	orgId: string
	domain: string
	pulumiJwtProfileJson: string
}

export interface ZitadelArgs {
	env: Environment
	config: ZitadelConfig
}

/**
 * Zitadel orchestrates all Zitadel identity resources.
 */
export class Zitadel {
	public readonly provider: zitadel.Provider
	public readonly project: zitadel.Project
	public readonly frontend: FrontendComponent

	constructor(name: string, args: ZitadelArgs) {
		const { env, config } = args

		this.provider = new zitadel.Provider(`${name}-provider`, {
			domain: config.domain,
			jwtProfileJson: config.pulumiJwtProfileJson,
		})

		this.project = new zitadel.Project(
			name,
			{
				name: name,
				orgId: config.orgId,
				// Minimal role settings for initial setup
				projectRoleAssertion: false,
				projectRoleCheck: false,
				hasProjectCheck: false,
				// Use default private labeling to avoid potential policy conflicts with instance SMTP
				privateLabelingSetting: 'PRIVATE_LABELING_SETTING_UNSPECIFIED',
			},
			{ provider: this.provider },
		)

		this.frontend = new FrontendComponent(name, {
			env,
			orgId: config.orgId,
			projectId: this.project.id,
			provider: this.provider,
		})
	}
}
