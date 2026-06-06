import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import { baseDomainMap } from '../constants.js'

export interface FrontendComponentArgs {
	env: Environment
	orgId: pulumi.Input<string>
	projectId: pulumi.Input<string>
	provider: zitadel.Provider
}

export class FrontendComponent extends pulumi.ComponentResource {
	public readonly application: zitadel.ApplicationOidc
	public readonly loginPolicy: zitadel.LoginPolicy
	public readonly labelPolicy: zitadel.LabelPolicy

	constructor(
		name: string,
		args: FrontendComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:Frontend', name, {}, opts)

		const { env, orgId, projectId, provider } = args
		const resourceOptions = { provider, parent: this }

		const domain = baseDomainMap[env]

		// Ternary spread (per `refactor-unify-env-dispatch`): localhost URIs
		// are only meaningful when env === 'dev'. Other envs receive the
		// public domain only.
		const redirectUris = [
			`https://${domain}/auth/callback`,
			...(env === 'dev' ? ['http://localhost:9000/auth/callback'] : []),
		]
		const postLogoutRedirectUris = [
			`https://${domain}/`,
			...(env === 'dev' ? ['http://localhost:9000/'] : []),
		]

		// 1. Define zitadel.ApplicationOidc resource
		this.application = new zitadel.ApplicationOidc(
			'web-frontend',
			{
				projectId: projectId,
				name: `web-frontend`,
				orgId: orgId,
				// Use JWT Access Token for easier stateless validation by backend services if needed
				accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
				// SPA (Single Page Application) running in the browser
				appType: 'OIDC_APP_TYPE_USER_AGENT',
				// PKCE flow (Proof Key for Code Exchange) requires no client secret for public clients
				authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
				// Standard OIDC flow for users; Refresh Token allows keeping the session alive without re-login
				grantTypes: [
					'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
					'OIDC_GRANT_TYPE_REFRESH_TOKEN',
				],
				// Explicitly set response type to CODE for PKCE
				responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
				// Assert roles in ID Token to simplify frontend logic
				idTokenRoleAssertion: true,
				// Assert user info in ID Token to reduce API calls
				idTokenUserinfoAssertion: true,
				// Strict clock skew validation
				clockSkew: '0s',
				redirectUris,
				postLogoutRedirectUris,
				// Allow http://localhost for development
				devMode: env === 'dev',
			},
			resourceOptions,
		)

		// 2. Define zitadel.LoginPolicy resource
		this.loginPolicy = new zitadel.LoginPolicy(
			'default',
			{
				orgId: orgId,
				// TODO: Revert to false once upstream fix is released.
				// Login V2 Register page does not render form fields when userLogin=false,
				// even with passwordlessType=ALLOWED. See: https://github.com/zitadel/zitadel/issues/11682
				//
				// LOAD-BEARING for E2E: the dev password-based test user provisioned
				// by `E2eTestUserComponent` (see ../index.ts and OpenSpec change
				// `playwright-password-test-user`) signs in via username + password
				// against THIS productOrg LoginPolicy. Password sign-in only works
				// while `userLogin: true`. When the upstream fix lands and this flag
				// is reverted to `false`, the reverting PR MUST EITHER:
				//   (a) remove `E2eTestUserComponent` and switch the headless E2E
				//       capture path back to passkey (currently no working option
				//       for WSL2), OR
				//   (b) move the e2e-test-user into a separate org whose own
				//       LoginPolicy has `userLogin: true`, OR
				//   (c) defer the revert until per-user passwordless-override
				//       support exists in Zitadel.
				// See the design.md Risks table in the `playwright-password-test-user`
				// OpenSpec change for the full mitigation record.
				userLogin: true,
				// `allowRegister` surfaces the Login UI v2 Register page. NOTE:
				// the register form's First name / Last name / Email fields are
				// HARDCODED and all `required` in the upstream login app
				// (`apps/login/.../register-form.tsx` at the deployed `v4.14.0`),
				// and the backend `AddHumanUser` requires `givenName`/`familyName`.
				// There is no login-policy / branding / login-UI setting to hide
				// or optional-ize First/Last name in v4.14.0, and we run the
				// upstream `zitadel-login` image unmodified (no custom CSS/JS
				// injection). Dropping those fields would require forking and
				// rebuilding the login image — deferred. See zitadel/zitadel
				// issue #4386 (remove required user fields).
				allowRegister: true,
				// Disable external IDPs (Google etc.) to enforce passkey-only authentication
				allowExternalIdp: false,
				forceMfa: false,
				forceMfaLocalOnly: false,
				// Allow Passwordless (Passkeys) for better UX and security
				passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
				hidePasswordReset: true, // Disable password reset flow since password login is disabled
				// User convenience: allow trying usernames without immediate rejection (security trade-off: enumeration possible)
				ignoreUnknownUsernames: true,
				defaultRedirectUri: `https://${domain}`,
				// Standard session and security lifetimes
				passwordCheckLifetime: '240h0m0s',
				externalLoginCheckLifetime: '240h0m0s',
				multiFactorCheckLifetime: '24h0m0s',
				mfaInitSkipLifetime: '720h0m0s',
				secondFactorCheckLifetime: '24h0m0s',
			},
			resourceOptions,
		)

		// 3. Define zitadel.LabelPolicy resource — product-org branding for the
		// hosted Login UI v2 (`/ui/v2/login/*`). Login UI v2 automatically
		// honors the org/instance label policy, so branding the product org +
		// enforcing it per-app (see `Project.privateLabelingSetting` in
		// ../index.ts) is all that is needed to on-brand the login screen.
		//
		// Colors are derived from the frontend brand tokens (oklch → hex):
		//   primary  #fd00a6  --color-brand-primary (pink)
		//   bg       #ffffff / #0d1023  white / --color-surface-base
		//   font     #161929 / #fafafa  dark navy / --color-text-primary
		//   warn     #f14d4c  --color-error
		// `logoPath`/`iconPath` are intentionally left unset — no brand logo
		// asset exists yet; the logo is a deferred fast-follow. `setActive`
		// stages-then-activates the policy so the change is live.
		this.labelPolicy = new zitadel.LabelPolicy(
			'brand',
			{
				orgId: orgId,
				primaryColor: '#fd00a6',
				primaryColorDark: '#fd00a6',
				backgroundColor: '#ffffff',
				backgroundColorDark: '#0d1023',
				fontColor: '#161929',
				fontColorDark: '#fafafa',
				warnColor: '#f14d4c',
				warnColorDark: '#f14d4c',
				// Follow the system theme; the v2 login exposes a toggle and both
				// palettes are defined.
				themeMode: 'THEME_MODE_AUTO',
				// Suppress any future Zitadel watermark.
				disableWatermark: true,
				// Cleaner consumer login name (no org-domain suffix).
				hideLoginNameSuffix: true,
				setActive: true,
			},
			resourceOptions,
		)

		this.registerOutputs({
			application: this.application,
			loginPolicy: this.loginPolicy,
			labelPolicy: this.labelPolicy,
		})
	}
}
