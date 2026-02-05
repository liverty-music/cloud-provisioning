import * as zitadel from '@pulumiverse/zitadel'
import * as pulumi from '@pulumi/pulumi'
import { Environment } from '../../config.js'
import { ZitadelConfig } from '../index.js'

export interface FrontendComponentArgs {
  env: Environment
  config: ZitadelConfig
}

export class FrontendComponent extends pulumi.ComponentResource {
  public readonly project: zitadel.Project
  public readonly application: zitadel.ApplicationOidc
  public readonly loginPolicy: zitadel.LoginPolicy
  public readonly provider: zitadel.Provider

  constructor(name: string, args: FrontendComponentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('zitadel:liverty-music:Frontend', name, {}, opts)

    const { env, config } = args

    // 1. Explicitly create a Zitadel Provider using the passed configuration
    this.provider = new zitadel.Provider(
      `${name}-provider`,
      {
        domain: config.domain,
        jwtProfileJson: config.pulumiJwtProfileJson,
      },
      { parent: this }
    )

    const resourceOptions = { provider: this.provider, parent: this }

    // 2.1 Define zitadel.Project resource
    this.project = new zitadel.Project(
      name,
      {
        name: name,
        orgId: config.orgId,
        // Minimal role settings for initial setup
        projectRoleAssertion: false,
        projectRoleCheck: false,
        hasProjectCheck: false,
        // Enforce this project's policies instead of organization default
        privateLabelingSetting: 'PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY',
      },
      resourceOptions
    )

    // 2.2 Define zitadel.ApplicationOidc resource
    this.application = new zitadel.ApplicationOidc(
      'frontend',
      {
        projectId: this.project.id,
        name: `${name}-frontend`,
        orgId: config.orgId,
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

    // 2.3 Define zitadel.LoginPolicy resource
    this.loginPolicy = new zitadel.LoginPolicy(
      'default',
      {
        orgId: config.orgId,
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
      project: this.project,
      application: this.application,
      loginPolicy: this.loginPolicy,
    })
  }
}
