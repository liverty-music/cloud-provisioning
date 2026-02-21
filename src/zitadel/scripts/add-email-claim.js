// Complement Token Flow — injects the `email` claim into JWT access tokens.
//
// Triggered at TRIGGER_TYPE_PRE_ACCESS_TOKEN_CREATION so every access token
// issued by Zitadel carries the user's email address.
//
// Why this is needed:
//   Zitadel does not include `email` in JWT access tokens by default (only in
//   ID tokens and the Userinfo endpoint). The backend JWTValidator requires the
//   `email` claim for user provisioning (UserService.Create). This Action is the
//   only supported mechanism to add it to access tokens.
//
// Caveats:
//   - Machine users (service accounts) have no `human` field; the guard below
//     prevents a runtime error and leaves their tokens unchanged.
//   - `setClaim` is a no-op if `email` already exists in the token (safe to
//     call unconditionally, but the guard also handles empty strings).
//   - Claims prefixed with `urn:zitadel:iam` are silently dropped by Zitadel;
//     `email` has no such prefix and is unaffected.
//   - `allowedToFail` should be false in staging/prod so that a script error
//     blocks token issuance (fail-fast) rather than silently omitting the claim.
//     This is configured in token-action.ts, not here.
//
// References:
//   Complement Token Flow:  https://zitadel.com/docs/apis/actions/complement-token
//   User object fields:     https://zitadel.com/docs/apis/actions/objects
//   Code examples:          https://zitadel.com/docs/apis/actions/code-examples
//
// biome-ignore lint/correctness/noUnusedVariables: called by Zitadel runtime by name, not imported
function addEmailClaim(ctx, api) {
	var user = ctx.v1.getUser()
	// biome-ignore lint/complexity/useOptionalChain: Zitadel Actions use ECMAScript 5.1; ?. is unavailable
	if (user && user.human && user.human.email) {
		api.v1.claims.setClaim('email', user.human.email)
	}
}
