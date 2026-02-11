import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'

export interface DnsSubdomainDelegationArgs {
	domain: string // e.g. "liverty-music.app"
	subdomain: string // e.g. "dev"
	nameservers: pulumi.Input<string[]>
}

/**
 * DnsSubdomainDelegation handles the delegation of a subdomain from Cloudflare
 * to external nameservers (like Google Cloud DNS) via NS records.
 */
export class DnsSubdomainDelegation extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: DnsSubdomainDelegationArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super(
			'cloudflare:liverty-music:DnsSubdomainDelegation',
			name,
			args,
			opts,
		)

		const { domain, subdomain, nameservers } = args

		// Get the zone ID for the root domain
		const zone = cloudflare.getZoneOutput(
			{
				filter: {
					name: domain,
				},
			},
			{ parent: this },
		)

		// Create NS records for the subdomain in Cloudflare
		// This delegates DNS authority for the subdomain to the provided nameservers.
		const nsRecords = pulumi.output(nameservers).apply((nsList) =>
			nsList.map(
				(ns, index) =>
					new cloudflare.Record(
						`${name}-ns-${index}`,
						{
							zoneId: zone.id,
							name: subdomain,
							type: 'NS',
							content: ns.endsWith('.') ? ns : `${ns}.`,
							ttl: 3600,
						},
						{ parent: this },
					),
			),
		)

		this.registerOutputs({
			zoneId: zone.id,
			nsRecords: nsRecords,
		})
	}
}
