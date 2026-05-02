import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../config.js'
import { ActionsV2Component } from './components/actions-v2.js'
import { FrontendComponent } from './components/frontend.js'
import { LoginClientComponent } from './components/login-client.js'
import { MachineUserComponent } from './components/machine-user.js'
import { SmtpComponent } from './components/smtp.js'
import {
	BACKEND_WEBHOOK_BASE_URL,
	PRE_ACCESS_TOKEN_PATH,
	ZITADEL_DEV_DEFAULT_ORG_ID,
	zitadelDomainMap,
} from './constants.js'

export * from './components/actions-v2.js'
export * from './components/frontend.js'
export * from './components/login-client.js'
export * from './components/machine-user.js'
export * from './components/secrets.js'
export * from './components/smtp.js'
export * from './constants.js'
export * from './dynamic/index.js'

export interface ZitadelArgs {
	env: Environment
	/** GCP project ID (e.g. `liverty-music-dev`) holding the GSM secret
	 *  `zitadel-admin-sa-key` populated by the in-cluster bootstrap-uploader. */
	gcpProjectId: pulumi.Input<string>
	/** Postmark Server API Token — used as both SMTP username and password. */
	postmarkServerApiToken: string
}

/**
 * Zitadel orchestrates all Zitadel identity resources against the in-cluster
 * self-hosted Zitadel instance reachable at the env-specific issuer hostname
 * (e.g. `https://auth.dev.liverty-music.app` for dev).
 *
 * Cutover from Zitadel Cloud → self-hosted happened in cloud-provisioning's
 * `self-hosted-zitadel-cutover` PR. The provider's `domain` input now reads
 * from `constants.ts:zitadelDomainMap[env]`, and `jwtProfileJson` is sourced
 * from the GSM secret `zitadel-admin-sa-key` that the in-cluster Zitadel
 * pod's `bootstrap-uploader` sidecar wrote on first boot.
 *
 * The Cloud tenant's Zitadel resources are intentionally NOT torn down by
 * this class — per OpenSpec D10, the Cloud tenant is retained as a rollback
 * target for two weeks. Pulumi state for those resources must be removed
 * manually before merging the cutover PR (see runbook in proposal.md).
 *
 * Cutover scope is dev-only (D10). The `env` guard below makes a staging /
 * prod attempt fail loudly until those environments get their own
 * `ZITADEL_DEFAULT_ORG_ID` (and any other env-specific bootstrap state)
 * threaded through.
 */
export class Zitadel {
	public readonly provider: zitadel.Provider
	public readonly project: zitadel.Project
	public readonly frontend: FrontendComponent
	public readonly smtp: SmtpComponent
	public readonly actionsV2: ActionsV2Component
	public readonly machineUser: MachineUserComponent
	public readonly loginClient: LoginClientComponent

	/** JWT profile JSON for the backend-app machine user. Store in Secret Manager. */
	public readonly machineKeyDetails: pulumi.Output<string>

	/** Personal Access Token for the zitadel-login (Login V2 UI) container.
	 *  Store in Secret Manager and mount via ExternalSecret as a file
	 *  (consumed by `ZITADEL_SERVICE_USER_TOKEN_FILE`). */
	public readonly loginClientToken: pulumi.Output<string>

	constructor(name: string, args: ZitadelArgs) {
		const { env, gcpProjectId, postmarkServerApiToken } = args

		if (env !== 'dev') {
			// Self-hosted Zitadel cutover is dev-only per OpenSpec D10.
			// Extending to staging / prod requires:
			//   - An env-keyed default-org-id source (constants.ts or
			//     a Dynamic Resource that discovers it from the admin SA key).
			//   - A bootstrapped self-hosted instance with admin-sa-key in
			//     that environment's GSM.
			//   - A separate cutover PR per environment.
			throw new Error(
				`Zitadel self-hosted cutover is dev-only; got env=${env}. ` +
					'See OpenSpec change "self-hosted-zitadel" §13 (cutover scope) ' +
					'and §15 (cooldown) for the staging/prod migration plan.',
			)
		}

		const orgId = ZITADEL_DEV_DEFAULT_ORG_ID
		const domain = zitadelDomainMap[env]

		// Pull the bootstrap-uploaded admin machine user JWT-profile JSON from
		// GSM. `secretData` is a `pulumi.Output<string>` that resolves at
		// preview/up time via the GCP Secret Manager API — no Pulumi-graph
		// dependency on `SecretsComponent` is needed (the secret is created
		// by SecretsComponent and populated out-of-band by the bootstrap
		// sidecar; we only read the latest version here).
		//
		// CRITICAL: wrap the result in `pulumi.secret()` so Pulumi marks the
		// value `[secret]` in state and preview output. Without this, the RSA
		// private key embedded in the JWT-profile JSON leaks into preview
		// logs, CI output, and Pulumi service history.
		const jwtProfileJson = pulumi.secret(
			gcp.secretmanager
				.getSecretVersionOutput({
					project: gcpProjectId,
					secret: 'zitadel-admin-sa-key',
					version: 'latest',
				})
				.apply((v) => v.secretData),
		)

		this.provider = new zitadel.Provider(`${name}-provider`, {
			domain,
			jwtProfileJson,
		})

		this.project = new zitadel.Project(
			name,
			{
				name: name,
				orgId,
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
			orgId,
			projectId: this.project.id,
			provider: this.provider,
		})

		this.smtp = new SmtpComponent(name, {
			env,
			serverApiToken: postmarkServerApiToken,
			provider: this.provider,
			domain,
			jwtProfileJson,
		})

		this.actionsV2 = new ActionsV2Component(name, {
			domain,
			jwtProfileJson,
			preAccessTokenEndpoint: `${BACKEND_WEBHOOK_BASE_URL}${PRE_ACCESS_TOKEN_PATH}`,
			provider: this.provider,
		})

		this.machineUser = new MachineUserComponent(name, {
			orgId,
			provider: this.provider,
		})

		this.machineKeyDetails = this.machineUser.keyDetails

		this.loginClient = new LoginClientComponent(name, {
			orgId,
			provider: this.provider,
		})

		this.loginClientToken = this.loginClient.token
	}
}
