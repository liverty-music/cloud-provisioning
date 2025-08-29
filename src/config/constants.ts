export const DEFAULT_REGION = 'asia-northeast2'
export const DEFAULT_ZONE = 'asia-northeast2-a'

export const REQUIRED_APIS = [
  'cloudresourcemanager.googleapis.com',
  'serviceusage.googleapis.com',
  'iam.googleapis.com',
  'cloudbilling.googleapis.com',
  'compute.googleapis.com',
  'storage.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  'cloudtrace.googleapis.com',
  'discoveryengine.googleapis.com',
  'geminicloudassist.googleapis.com', // required for Gemini Cloud Assist
  'cloudasset.googleapis.com', // recommended for Gemini Cloud Assist
  'recommender.googleapis.com', // recommended for Gemini Cloud Assist
  'aiplatform.googleapis.com',
]

export const ENVIRONMENT_CONFIGS = {
  dev: {
    suffix: 'dev',
    apis: [...REQUIRED_APIS],
  },
  staging: {
    suffix: 'staging',
    apis: [...REQUIRED_APIS],
  },
  prod: {
    suffix: 'prod',
    apis: [
      ...REQUIRED_APIS,
      'securitycenter.googleapis.com', // Correct endpoint for Security Command Center
    ],
  },
} as const
