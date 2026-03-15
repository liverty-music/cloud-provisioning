import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'

export interface SmtpComponentArgs {
	env: Environment
	smtpUser: string
	smtpPassword: string
	provider: zitadel.Provider
}

// Sender address per environment using dedicated mail subdomains.
// Subdomains isolate email sending reputation from the web domain.
const senderAddressMap: Record<Environment, string> = {
	dev: 'noreply@mail.dev.liverty-music.app',
	staging: 'noreply@mail.staging.liverty-music.app',
	prod: 'noreply@mail.liverty-music.app',
}

export class SmtpComponent extends pulumi.ComponentResource {
	public readonly smtpConfig: zitadel.SmtpConfig

	constructor(
		name: string,
		args: SmtpComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:Smtp', name, {}, opts)

		const { env, smtpUser, smtpPassword, provider } = args
		const resourceOptions = { provider, parent: this }

		this.smtpConfig = new zitadel.SmtpConfig(
			'postmark',
			{
				senderAddress: senderAddressMap[env],
				senderName: 'Liverty Music',
				tls: true,
				host: 'smtp.postmarkapp.com:587',
				user: smtpUser,
				password: pulumi.secret(smtpPassword),
			},
			resourceOptions,
		)

		this.registerOutputs({
			smtpConfig: this.smtpConfig,
		})
	}
}
