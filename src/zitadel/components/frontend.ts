import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'

export interface FrontendComponentArgs {
	env: Environment
	orgId: pulumi.Input<string>
	projectId: pulumi.Input<string>
	provider: zitadel.Provider
}

export class FrontendComponent extends pulumi.ComponentResource {
	public readonly application: zitadel.ApplicationOidc
	public readonly loginPolicy: zitadel.LoginPolicy

	constructor(
		name: string,
		args: FrontendComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:Frontend', name, {}, opts)

		const { env, orgId, projectId, provider } = args
		const resourceOptions = { provider, parent: this }

		// Environment-specific domains
		const domainMap: Record<Environment, string> = {
			dev: 'dev.liverty-music.app',
			staging: 'staging.liverty-music.app',
			prod: 'liverty-music.app',
		}
		const domain = domainMap[env]

		const redirectUris = [`https://${domain}/auth/callback`]
		const postLogoutRedirectUris = [`https://${domain}/signedout`]
		if (env === 'dev') {
			redirectUris.push('http://localhost:9000/auth/callback')
			postLogoutRedirectUris.push('http://localhost:9000/signedout')
		}

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
				// Disable username/password login (userLogin=false disables password auth)
				userLogin: false,
				allowRegister: true,
				// Enable External IDPs (Google) for verification
				allowExternalIdp: true,
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

		this.registerOutputs({
			application: this.application,
			loginPolicy: this.loginPolicy,
		})
	}
}
