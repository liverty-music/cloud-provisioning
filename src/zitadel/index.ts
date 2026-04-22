import type * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../config.js'
import { FrontendComponent } from './components/frontend.js'
import { MachineUserComponent } from './components/machine-user.js'
import { SmtpComponent } from './components/smtp.js'
import { ActionsComponent } from './components/token-action.js'

export * from './components/actions-v2.js'
export * from './components/frontend.js'
export * from './components/machine-user.js'
export * from './components/secrets.js'
export * from './components/smtp.js'
export * from './components/token-action.js'
export * from './dynamic/index.js'

export interface ZitadelConfig {
	orgId: string
	domain: string
	pulumiJwtProfileJson: string
	/** Postmark Server API Token — used as both SMTP username and password. */
	postmarkServerApiToken: string
}

export interface ZitadelArgs {
	env: Environment
	config: ZitadelConfig
}

/**
 * Zitadel orchestrates all Zitadel identity resources against a Zitadel
 * Management API (currently the Zitadel Cloud dev tenant; migrates to the
 * in-cluster self-hosted instance in a follow-up "cutover" PR).
 *
 * During the migration window, the self-hosted infra (GSM secret shells,
 * Cloud SQL DB/user, K8s manifests) is provisioned alongside this class by
 * `SecretsComponent` and the `k8s/namespaces/zitadel/` Kustomize base — but
 * this class continues to configure the Cloud tenant to keep dev auth
 * functional. The cutover PR swaps this class's `ActionsComponent` (v1) for
 * `ActionsV2Component` (v2) at the same time the provider `domain` input
 * flips to the self-hosted hostname.
 */
export class Zitadel {
	public readonly provider: zitadel.Provider
	public readonly project: zitadel.Project
	public readonly frontend: FrontendComponent
	public readonly smtp: SmtpComponent
	public readonly actions: ActionsComponent
	public readonly machineUser: MachineUserComponent

	/** JWT profile JSON for the backend-app machine user. Store in Secret Manager. */
	public readonly machineKeyDetails: pulumi.Output<string>

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

		this.smtp = new SmtpComponent(name, {
			env,
			serverApiToken: config.postmarkServerApiToken,
			provider: this.provider,
		})

		this.actions = new ActionsComponent(name, {
			env,
			orgId: config.orgId,
			provider: this.provider,
		})

		this.machineUser = new MachineUserComponent(name, {
			orgId: config.orgId,
			provider: this.provider,
		})

		this.machineKeyDetails = this.machineUser.keyDetails
	}
}
