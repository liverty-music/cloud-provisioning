// Complement Token Flow — injects `email` and `email_verified` claims into JWT
// access tokens.
//
// Triggered at TRIGGER_TYPE_PRE_ACCESS_TOKEN_CREATION so every access token
// issued by Zitadel carries the user's email address and verification status.
//
// Why this is needed:
//   Zitadel does not include `email` or `email_verified` in JWT access tokens
//   by default (only in ID tokens and the Userinfo endpoint). The backend
//   JWTValidator requires the `email` claim for user provisioning and
//   `email_verified` for email verification enforcement.
//
// Caveats:
//   - Machine users (service accounts) have no `human` field; the guard below
//     prevents a runtime error and leaves their tokens unchanged.
//   - `setClaim` is a no-op if the claim already exists in the token (safe to
//     call unconditionally, but the guard also handles empty strings).
//   - Claims prefixed with `urn:zitadel:iam` are silently dropped by Zitadel;
//     `email` and `email_verified` have no such prefix and are unaffected.
//   - `allowedToFail` should be false in staging/prod so that a script error
//     blocks token issuance (fail-fast) rather than silently omitting claims.
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
		api.v1.claims.setClaim(
			'email_verified',
			user.human.isEmailVerified || false,
		)
	}
}
