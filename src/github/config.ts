export interface GitHubConfig {
  owner: string
  token: string
  billingEmail: string
  geminiApiKey?: string
}

export interface BufConfig {
  token: string
}

export enum RepositoryName {
  CLOUD_PROVISIONING = 'cloud-provisioning',
  SPECIFICATION = 'specification',
  BACKEND = 'backend',
  FRONTEND = 'frontend',
}

export type EnvironmentName = 'development' | 'production' | 'staging'
