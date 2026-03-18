import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface ActionsComponentArgs {
	env: Environment
	orgId: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * ActionsComponent manages all Zitadel Actions and their trigger wiring.
 *
 * Each action is defined as a named property so callers can reference
 * individual resources if needed. TriggerActions group actions by flow/trigger.
 */
export class ActionsComponent extends pulumi.ComponentResource {
	/** Injects the `email` claim into every JWT access token before issuance. */
	public readonly addEmailClaimAction: zitadel.Action

	/** Auto-verifies user email during Self-Registration to skip the OTP step. */
	public readonly autoVerifyEmailAction: zitadel.Action

	/** Wires pre-access-token-creation actions to the customise-token flow. */
	public readonly preAccessTokenTrigger: zitadel.TriggerActions

	/** Wires pre-creation actions to the internal-authentication flow. */
	public readonly preCreationTrigger: zitadel.TriggerActions

	constructor(
		name: string,
		args: ActionsComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:Actions', name, {}, opts)

		const { env, orgId, provider } = args
		const resourceOptions = { provider, parent: this }

		// In dev, allow actions to fail so token issuance is not blocked by
		// script errors during development iteration.
		// In staging and prod, failures must block the token.
		const allowedToFail = env === 'dev'

		// Inject user email into the access token.
		// Zitadel does not include `email` in access tokens by default; the
		// backend JWTValidator requires it for user provisioning.
		// Guard ensures machine users (no human.email) are unaffected.
		const addEmailClaimScript = readFileSync(
			resolve(__dirname, '../scripts/add-email-claim.js'),
			'utf-8',
		)

		this.addEmailClaimAction = new zitadel.Action(
			'add-email-claim',
			{
				orgId,
				// Action name must exactly match the JavaScript function name in the script.
				// Zitadel calls the function by this name at runtime; a mismatch causes
				// silent non-execution. JS identifiers cannot contain hyphens, so we use camelCase.
				name: 'addEmailClaim',
				script: addEmailClaimScript,
				timeout: '10s',
				allowedToFail,
			},
			resourceOptions,
		)

		// Auto-verify email during Self-Registration.
		// When SMTP is configured, Zitadel's Hosted Login blocks the OIDC
		// flow with an email OTP step. By calling setEmailVerified(true) in
		// PRE_CREATION, the user is created with email already verified and
		// the OTP step is skipped entirely.
		const autoVerifyEmailScript = readFileSync(
			resolve(__dirname, '../scripts/auto-verify-email.js'),
			'utf-8',
		)

		this.autoVerifyEmailAction = new zitadel.Action(
			'auto-verify-email',
			{
				orgId,
				name: 'autoVerifyEmail',
				script: autoVerifyEmailScript,
				timeout: '10s',
				allowedToFail,
			},
			resourceOptions,
		)

		// Wire auto-verify to the internal authentication flow's PRE_CREATION
		// trigger. This fires after the user fills in the registration form
		// and before Zitadel creates the user record.
		this.preCreationTrigger = new zitadel.TriggerActions(
			'internal-auth-pre-creation',
			{
				orgId,
				flowType: 'FLOW_TYPE_INTERNAL_AUTHENTICATION',
				triggerType: 'TRIGGER_TYPE_PRE_CREATION',
				actionIds: [this.autoVerifyEmailAction.id],
			},
			{ ...resourceOptions, dependsOn: [this.autoVerifyEmailAction] },
		)

		// TriggerActions wires one or more Actions to a specific point in
		// Zitadel's OIDC lifecycle (flow + trigger).
		//
		// flowType:    FLOW_TYPE_CUSTOMISE_TOKEN
		//   The "Complement Token" flow — runs after authentication succeeds
		//   and before the token is returned to the client.
		//
		// triggerType: TRIGGER_TYPE_PRE_ACCESS_TOKEN_CREATION
		//   Fires immediately before the JWT access token is signed and issued.
		//   This is the only trigger where claims can still be added to the
		//   access token. Adding the same Action to PRE_USERINFO_CREATION would
		//   also cover the /userinfo endpoint if needed in future.
		//
		// actionIds:   list of Action IDs to execute at this trigger point,
		//   in order. Currently only addEmailClaimAction.
		this.preAccessTokenTrigger = new zitadel.TriggerActions(
			'customise-token-pre-access',
			{
				orgId,
				flowType: 'FLOW_TYPE_CUSTOMISE_TOKEN',
				triggerType: 'TRIGGER_TYPE_PRE_ACCESS_TOKEN_CREATION',
				actionIds: [this.addEmailClaimAction.id],
			},
			{ ...resourceOptions, dependsOn: [this.addEmailClaimAction] },
		)

		this.registerOutputs({
			addEmailClaimAction: this.addEmailClaimAction,
			autoVerifyEmailAction: this.autoVerifyEmailAction,
			preAccessTokenTrigger: this.preAccessTokenTrigger,
			preCreationTrigger: this.preCreationTrigger,
		})
	}
}
