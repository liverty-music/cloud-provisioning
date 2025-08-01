import * as pulumi from '@pulumi/pulumi'
import { DEFAULT_REGION, ENVIRONMENT_CONFIGS } from './constants.js'

export interface EnvironmentConfig {
  environment: 'dev' | 'staging' | 'prod'
  projectId: string
  region: string
  zone?: string
  enabledApis: string[]
}

export function getEnvironmentConfig(projectPrefix: string): EnvironmentConfig {
  const config = new pulumi.Config()
  const stack = pulumi.getStack() as 'dev' | 'staging' | 'prod'

  const envConfig = ENVIRONMENT_CONFIGS[stack]

  return {
    environment: stack,
    projectId: `${projectPrefix}-${stack}`,
    region: config.get('region') || DEFAULT_REGION,
    zone: config.get('zone'),
    enabledApis: [...envConfig.apis],
  }
}
