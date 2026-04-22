import * as pulumi from '@pulumi/pulumi'
import type * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import {
	ZitadelExecutionFunction,
	ZitadelExecutionRequest,
	ZitadelTarget,
} from '../dynamic/index.js'

export interface ActionsV2ComponentArgs {
	env: Environment
	/** Zitadel domain hosting the Management API (e.g. `auth.dev.liverty-music.app`). */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON, used by Dynamic Resources for REST auth. */
	jwtProfileJson: pulumi.Input<string>
	/** In-cluster URL of the backend `/pre-access-token` webhook handler. */
	preAccessTokenEndpoint: pulumi.Input<string>
	/** In-cluster URL of the backend auto-verify-email webhook handler. */
	autoVerifyEmailEndpoint: pulumi.Input<string>
	/** Pulumi Zitadel v1 provider — required as a `dependsOn` marker so executions
	 *  are created after the Management API is reachable via the provider. */
	provider: zitadel.Provider
}

/**
 * ActionsV2Component provisions the Zitadel Actions v2 Targets and Execution
 * bindings that replace the deprecated Actions v1 JavaScript mechanism.
 *
 * Two flows are wired:
 *   1. `preaccesstoken` — injects the `email` claim into JWT access tokens
 *      before issuance (replaces `addEmailClaim` v1 Action).
 *   2. `AddHumanUser` request — marks new users' emails as verified during
 *      Self-Registration (replaces the `INTERNAL_AUTHENTICATION/PRE_CREATION`
 *      v1 Action that called `api.setEmailVerified(true)`).
 *
 * Both Targets use `PAYLOAD_TYPE_JWT` so the backend verifies incoming webhook
 * requests with its existing JWKS validator — no shared HMAC secret needed.
 *
 * In `dev`, `interruptOnError: false` allows the flow to fall back to OTP / no
 * claim if the backend webhook is unavailable. In staging/prod this flips to
 * `true` so operational failures fail closed.
 */
export class ActionsV2Component extends pulumi.ComponentResource {
	public readonly preAccessTokenTarget: ZitadelTarget
	public readonly preAccessTokenExecution: ZitadelExecutionFunction
	public readonly autoVerifyEmailTarget: ZitadelTarget
	public readonly autoVerifyEmailExecution: ZitadelExecutionRequest

	constructor(
		name: string,
		args: ActionsV2ComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:ActionsV2', name, {}, opts)

		const {
			env,
			domain,
			jwtProfileJson,
			preAccessTokenEndpoint,
			autoVerifyEmailEndpoint,
			provider,
		} = args
		const interruptOnError = env !== 'dev'

		// 1. Email-claim injection Target + ExecutionFunction
		// REST_CALL waits for the response so the token can be complemented
		// with claims. PAYLOAD_TYPE_JWT lets the backend verify with its
		// existing Zitadel JWKS validator.
		this.preAccessTokenTarget = new ZitadelTarget(
			'pre-access-token-webhook',
			{
				domain,
				jwtProfileJson,
				name: 'pre-access-token-webhook',
				endpoint: preAccessTokenEndpoint,
				targetType: 'REST_CALL',
				timeout: '10s',
				payloadType: 'PAYLOAD_TYPE_JWT',
				interruptOnError,
			},
			{ parent: this, dependsOn: [provider] },
		)

		this.preAccessTokenExecution = new ZitadelExecutionFunction(
			'pre-access-token-execution',
			{
				domain,
				jwtProfileJson,
				functionName: 'preaccesstoken',
				targetIds: [this.preAccessTokenTarget.targetId],
			},
			{
				parent: this,
				dependsOn: [this.preAccessTokenTarget],
			},
		)

		// 2. Auto-verify-email Target + ExecutionRequest
		// REST_CALL on the AddHumanUser request mutates the incoming payload
		// to set `email.is_verified = true` before Zitadel persists the user.
		// Method path pinned to v2 UserService; adjust here if Zitadel renames
		// the gRPC service in a future release.
		this.autoVerifyEmailTarget = new ZitadelTarget(
			'auto-verify-email-webhook',
			{
				domain,
				jwtProfileJson,
				name: 'auto-verify-email-webhook',
				endpoint: autoVerifyEmailEndpoint,
				targetType: 'REST_CALL',
				timeout: '5s',
				payloadType: 'PAYLOAD_TYPE_JWT',
				interruptOnError,
			},
			{ parent: this, dependsOn: [provider] },
		)

		this.autoVerifyEmailExecution = new ZitadelExecutionRequest(
			'auto-verify-email-execution',
			{
				domain,
				jwtProfileJson,
				method: '/zitadel.user.v2.UserService/AddHumanUser',
				targetIds: [this.autoVerifyEmailTarget.targetId],
			},
			{
				parent: this,
				dependsOn: [this.autoVerifyEmailTarget],
			},
		)

		this.registerOutputs({
			preAccessTokenTargetId: this.preAccessTokenTarget.targetId,
			autoVerifyEmailTargetId: this.autoVerifyEmailTarget.targetId,
		})
	}
}
