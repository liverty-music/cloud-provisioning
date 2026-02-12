import type * as pulumi from '@pulumi/pulumi'

export interface CloudflareConfig {
	apiToken: pulumi.Input<string>
	zoneId: pulumi.Input<string>
}
