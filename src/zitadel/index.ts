import type * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../config.js'
import { ActionsV2Component } from './components/actions-v2.js'
import { FrontendComponent } from './components/frontend.js'
import { MachineUserComponent } from './components/machine-user.js'
import { SmtpComponent } from './components/smtp.js'

export * from './components/actions-v2.js'
export * from './components/frontend.js'
export * from './components/machine-user.js'
export * from './components/secrets.js'
export * from './components/smtp.js'
export * from './dynamic/index.js'

export interface ZitadelConfig {
	orgId: string
	/** Zitadel domain (self-hosted). In dev this is `auth.dev.liverty-music.app`. */
	domain: string
	/**
	 * Admin machine user JWT profile JSON used by `@pulumiverse/zitadel` and by
	 * the Dynamic Resource providers. In self-hosted mode this is sourced from
	 * the GCP Secret Manager secret `zitadel-admin-sa-key`, populated by the
	 * in-cluster bootstrap Job on first boot.
	 */
	pulumiJwtProfileJson: pulumi.Input<string>
	/** Postmark Server API Token — used as both SMTP username and password. */
	postmarkServerApiToken: string
	/** In-cluster URL of the backend `/pre-access-token` webhook handler. */
	preAccessTokenEndpoint: string
	/** In-cluster URL of the backend auto-verify-email webhook handler. */
	autoVerifyEmailEndpoint: string
}

export interface ZitadelArgs {
	env: Environment
	config: ZitadelConfig
}

/**
 * Zitadel orchestrates the configuration-phase Zitadel resources against an
 * already-running Zitadel instance (whether self-hosted in-cluster or Zitadel
 * Cloud — the shape is the same, only the `domain` and `pulumiJwtProfileJson`
 * inputs differ).
 *
 * Infra-phase resources (masterkey + admin-sa-key GSM secrets) live in
 * `./components/secrets.ts` and are instantiated before this class so the
 * in-cluster bootstrap Job can populate the admin SA key that this class
 * consumes for Management API auth.
 */
export class Zitadel {
	public readonly provider: zitadel.Provider
	public readonly project: zitadel.Project
	public readonly frontend: FrontendComponent
	public readonly smtp: SmtpComponent
	public readonly actions: ActionsV2Component
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

		this.actions = new ActionsV2Component(name, {
			env,
			domain: config.domain,
			jwtProfileJson: config.pulumiJwtProfileJson,
			preAccessTokenEndpoint: config.preAccessTokenEndpoint,
			autoVerifyEmailEndpoint: config.autoVerifyEmailEndpoint,
			provider: this.provider,
		})

		this.machineUser = new MachineUserComponent(name, {
			orgId: config.orgId,
			provider: this.provider,
		})

		this.machineKeyDetails = this.machineUser.keyDetails
	}
}
