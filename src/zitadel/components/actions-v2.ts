import * as pulumi from '@pulumi/pulumi'
import type * as zitadel from '@pulumiverse/zitadel'
import {
	ZitadelExecutionEvent,
	ZitadelExecutionFunction,
	ZitadelTarget,
} from '../dynamic/index.js'

export interface ActionsV2ComponentArgs {
	/** Zitadel domain hosting the Management API (e.g. `auth.dev.liverty-music.app`). */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON, used by Dynamic Resources for REST auth. */
	jwtProfileJson: pulumi.Input<string>
	/** In-cluster URL of the backend `/pre-access-token` webhook handler. */
	preAccessTokenEndpoint: pulumi.Input<string>
	/** In-cluster URL of the backend `/account-login-event` webhook handler —
	 *  the account.login source, bound to the session.user.checked event. */
	loginEventEndpoint: pulumi.Input<string>
	/** Pulumi Zitadel v1 provider — required as a `dependsOn` marker so executions
	 *  are created after the Management API is reachable via the provider. */
	provider: zitadel.Provider
}

/**
 * ActionsV2Component provisions the Zitadel Actions v2 Targets and Execution
 * bindings that replace the deprecated Actions v1 JavaScript mechanism.
 *
 * Currently wires only the `preaccesstoken` flow — injects the `email` claim
 * into JWT access tokens before issuance (replaces `addEmailClaim` v1 Action).
 * Email-claim injection MUST always fail closed: every backend code path
 * reads `email` from the access token, so a tokens-without-email outage is
 * a hard auth failure across the whole product (identity-management spec
 * hard invariant).
 *
 * The Target uses `PAYLOAD_TYPE_JWT` so the backend verifies incoming
 * webhook requests with its existing JWKS validator — no shared HMAC secret
 * needed.
 *
 * ## Removed: auto-verify-email Action
 *
 * The previous version provisioned a second Action — an `ExecutionRequest`
 * on `/zitadel.user.v2.UserService/AddHumanUser` that called a backend
 * webhook returning `{ email: { is_verified: true } }` to mark new users'
 * emails as verified during Self-Registration (replacing the
 * `INTERNAL_AUTHENTICATION/PRE_CREATION` v1 Action).
 *
 * That binding has been removed because:
 *
 *   1. Zitadel v4 Actions v2 `request:*` Executions REPLACE the request body
 *      with the webhook response (not merge-patch). Returning only `{email:
 *      {is_verified: true}}` therefore strips Profile, the rest of Email,
 *      Phone, etc. from the AddHumanUser request, causing the API to fail
 *      with `invalid AddHumanUserRequest.Profile: value is required`. See
 *      https://github.com/zitadel/zitadel/issues/9748 for the analogous bug
 *      report on `RetrieveIdentityProviderIntent`.
 *
 *   2. Empirically the Action also failed to mark emails as verified even
 *      under the old Zitadel Cloud setup — users were still prompted for
 *      the email-verification OTP during sign-up, despite the Action
 *      supposedly returning `is_verified: true`. The mechanism never
 *      actually delivered the intended UX.
 *
 * Email verification therefore proceeds via Zitadel's default OTP step.
 * If we want passkey-only sign-ups to skip the email-verification screen
 * later, the proper fix is either:
 *   - Disable the email-verification step at the LoginPolicy level, or
 *   - Reconstruct the full AddHumanUserRequest in the webhook response
 *     (parse the JWT body, mutate `email.is_verified`, return the entire
 *     request payload).
 */
export class ActionsV2Component extends pulumi.ComponentResource {
	public readonly preAccessTokenTarget: ZitadelTarget
	public readonly preAccessTokenExecution: ZitadelExecutionFunction
	public readonly loginEventTarget: ZitadelTarget
	public readonly loginEventExecution: ZitadelExecutionEvent

	constructor(
		name: string,
		args: ActionsV2ComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:ActionsV2', name, {}, opts)

		const {
			domain,
			jwtProfileJson,
			preAccessTokenEndpoint,
			loginEventEndpoint,
			provider,
		} = args

		// Email-claim injection Target + ExecutionFunction.
		// REST_CALL waits for the response so the token can be complemented
		// with claims. PAYLOAD_TYPE_JWT lets the backend verify with its
		// existing Zitadel JWKS validator. `interruptOnError` is true in all
		// environments because every backend code path requires the email
		// claim — token issuance must fail closed if injection fails.
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
				interruptOnError: true,
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

		// Login-event Target + ExecutionEvent — the account.login source.
		// REST_CALL with PAYLOAD_TYPE_JSON (the Zitadel-recommended default):
		// Zitadel signs each body with an HMAC and the backend verifies the
		// `ZITADEL-Signature` header with the Target's generated `signingKey`
		// (captured below and plumbed to the backend via GSM/ESO). PAYLOAD_TYPE_JWT
		// is NOT used here: an event-execution JWT target requires an active
		// instance web key, which this instance lacks — it fails with
		// `Errors.WebKey.NoActive` (whereas the function-based pre-access-token
		// target signs in the OIDC context and is unaffected). `interruptOnError`
		// is FALSE: analytics must never block login. Unlike the reverted
		// `response`-on-CreateSession approach, an EVENT execution is
		// fire-and-forget — Zitadel ignores the webhook response — so it cannot
		// strip the session response or otherwise break sign-in.
		this.loginEventTarget = new ZitadelTarget(
			'login-event-webhook',
			{
				domain,
				jwtProfileJson,
				name: 'login-event-webhook',
				endpoint: loginEventEndpoint,
				targetType: 'REST_CALL',
				timeout: '10s',
				payloadType: 'PAYLOAD_TYPE_JSON',
				interruptOnError: false,
			},
			{ parent: this, dependsOn: [provider] },
		)

		// Bound to `session.user.checked`: stored once per interactive login via
		// the hosted Login UI, never on a refresh_token grant (which touches only
		// the oidc_session aggregate) and never on a machine jwt_profile grant.
		// Event type determined empirically via the Zitadel Events API.
		this.loginEventExecution = new ZitadelExecutionEvent(
			'login-event-execution',
			{
				domain,
				jwtProfileJson,
				eventType: 'session.user.checked',
				targetIds: [this.loginEventTarget.targetId],
			},
			{
				parent: this,
				dependsOn: [this.loginEventTarget],
			},
		)

		this.registerOutputs({
			preAccessTokenTargetId: this.preAccessTokenTarget.targetId,
			loginEventTargetId: this.loginEventTarget.targetId,
		})
	}
}
