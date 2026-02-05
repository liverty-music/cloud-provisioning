import * as zitadel from '@pulumiverse/zitadel'
import { FrontendComponent, FrontendComponentArgs } from './components/frontend.js'
import { Environment } from '../config.js'

export * from './components/frontend.js'

export interface ZitadelConfig {
  orgId: string
  domain: string
  pulumiJwtProfileJson: string
}

export interface SetupZitadelArgs {
  env: Environment
  config: ZitadelConfig
}

/**
 * setupZitadel initializes the core Zitadel infrastructure resources (Provider and Project)
 * and the FrontendComponent for OIDC/Login settings.
 *
 * This follows the requested pattern of managing global resources directly while
 * encapsulating application-specific settings in components.
 */
export function setupZitadel(name: string, args: SetupZitadelArgs) {
  const { env, config } = args

  const provider = new zitadel.Provider(`${name}-provider`, {
    domain: config.domain,
    jwtProfileJson: config.pulumiJwtProfileJson,
  })

  const project = new zitadel.Project(
    name,
    {
      name: name,
      orgId: config.orgId,
      privateLabelingSetting: 'PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY',
    },
    { provider }
  )

  const frontend = new FrontendComponent(name, {
    env,
    orgId: config.orgId,
    projectId: project.id,
    provider,
  })

  return {
    provider,
    project,
    frontend,
  }
}
