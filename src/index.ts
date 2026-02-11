import * as pulumi from '@pulumi/pulumi'
import { DnsSubdomainDelegation } from './cloudflare/components/dns-subdomain-delegation.js'
import type { Environment } from './config.js'
import type { GcpConfig } from './gcp/components/project.js'
import { Gcp } from './gcp/index.js'
import {
	type BufConfig,
	type GitHubConfig,
	GitHubOrganizationComponent,
	GitHubRepositoryComponent,
	RepositoryName,
} from './github/index.js'
import { Zitadel, type ZitadelConfig } from './zitadel/index.js'

const brandId = 'liverty-music'
const displayName = 'Liverty Music'

const config = new pulumi.Config('liverty-music')
const githubConfig = config.requireObject('github') as GitHubConfig
const gcpConfig = config.requireObject('gcp') as GcpConfig
const bufConfig = config.requireObject('buf') as BufConfig
const zitadelConfig = config.requireObject('zitadel') as ZitadelConfig

const env = pulumi.getStack() as Environment

// 1. GitHub Organization Configuration (Prod Only)
if (env === 'prod') {
	new GitHubOrganizationComponent({
		brandId,
		displayName,
		githubConfig: {
			...githubConfig,
			geminiApiKey: gcpConfig.geminiApiKey,
		},
		bufConfig,
	})
}

// 4. Zitadel Identity
if (env === 'dev') {
	new Zitadel('liverty-music', {
		env,
		config: zitadelConfig,
	})
}

// 2. GCP Infrastructure (All Environments)
const gcp = new Gcp({
	brandId,
	displayName,
	environment: env,
	gcpConfig,
	publicDomain: gcpConfig.domains?.publicDomain,
})

// 3. GitHub Repository Environments (All Environments)
new GitHubRepositoryComponent({
	brandId,
	githubConfig,
	repositoryName: RepositoryName.BACKEND,
	environment: env,
	variables: {
		REGION: gcp.region,
		PROJECT_ID: gcp.projectId,
		WORKLOAD_IDENTITY_PROVIDER: gcp.githubWorkloadIdentityProvider,
		SERVICE_ACCOUNT: gcp.githubActionsSAEmail,
	},
})

// 5. DNS Subdomain Delegation (Dev/Staging Only)
if (
	env !== 'prod' &&
	gcp.publicZoneNameservers &&
	gcpConfig.domains?.publicDomain
) {
	new DnsSubdomainDelegation('subdomain-delegation', {
		domain: gcpConfig.domains.publicDomain,
		subdomain: env,
		nameservers: gcp.publicZoneNameservers,
	})
}

// Export common resources
export const folder = gcp.folder
export const project = gcp.project
// Export for debug/reference
export const githubEnv = env
