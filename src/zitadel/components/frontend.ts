import * as zitadel from '@pulumiverse/zitadel'
import * as pulumi from '@pulumi/pulumi'
import { Environment } from '../../config.js'

export interface FrontendComponentArgs {
  env: Environment
  orgId: pulumi.Input<string>
  projectId: pulumi.Input<string>
  provider: zitadel.Provider
}

export class FrontendComponent extends pulumi.ComponentResource {
  public readonly application: zitadel.ApplicationOidc
  public readonly loginPolicy: zitadel.LoginPolicy

  constructor(name: string, args: FrontendComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('zitadel:liverty-music:Frontend', name, {}, opts)

    const { env, orgId, projectId, provider } = args
    const resourceOptions = { provider, parent: this }

    // 1. Define zitadel.ApplicationOidc resource
    this.application = new zitadel.ApplicationOidc(
      'frontend',
      {
        projectId: projectId,
        name: `${name}-frontend`,
        orgId: orgId,
        accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
        appType: 'OIDC_APP_TYPE_USER_AGENT',
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
        grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
        responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
        idTokenRoleAssertion: true,
        idTokenUserinfoAssertion: true,
        clockSkew: '0s',
        redirectUris: ['http://localhost:9000/auth/callback'],
        postLogoutRedirectUris: ['http://localhost:9000/signedout'],
        devMode: env === 'dev',
      },
      resourceOptions
    )

    // 2. Define zitadel.LoginPolicy resource
    this.loginPolicy = new zitadel.LoginPolicy(
      'default',
      {
        orgId: orgId,
        userLogin: false,
        allowRegister: true,
        allowExternalIdp: false,
        forceMfa: false,
        forceMfaLocalOnly: false,
        passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
        hidePasswordReset: true,
        ignoreUnknownUsernames: true,
        defaultRedirectUri: 'http://localhost:9000',
        passwordCheckLifetime: '240h0m0s',
        externalLoginCheckLifetime: '240h0m0s',
        multiFactorCheckLifetime: '24h0m0s',
        mfaInitSkipLifetime: '720h0m0s',
        secondFactorCheckLifetime: '24h0m0s',
      },
      resourceOptions
    )

    this.registerOutputs({
      application: this.application,
      loginPolicy: this.loginPolicy,
    })
  }
}
