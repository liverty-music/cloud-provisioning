// Internal Authentication Flow — auto-verifies the user's email before
// account creation so that Zitadel skips the OTP verification step during
// Self-Registration.
//
// Triggered at TRIGGER_TYPE_PRE_CREATION within FLOW_TYPE_INTERNAL_AUTHENTICATION.
//
// Why this is needed:
//   When SMTP is configured, Zitadel's Hosted Login blocks the OIDC
//   authorization flow with an email OTP step during Self-Registration.
//   On mobile, switching to the mail app to copy a code causes user
//   abandonment. Since no current feature requires a verified email,
//   we auto-verify at creation time and skip the OTP step entirely.
//
// Trade-off:
//   `email_verified` will be `true` for all new users from the start.
//   If a future feature needs proof-of-email, a re-verification flow
//   can be introduced at that point.
//
// References:
//   Internal Authentication Flow:  https://zitadel.com/docs/apis/actions/internal-authentication
//   Pre Creation trigger API:      https://zitadel.com/docs/apis/actions/external-authentication
//
var logger = require('zitadel/log')

// biome-ignore lint/correctness/noUnusedVariables: called by Zitadel runtime by name, not imported
function autoVerifyEmail(ctx, api) {
	api.setEmailVerified(true)
	logger.log('email auto-verified during self-registration')
}
