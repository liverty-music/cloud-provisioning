import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import { ZitadelSmtpActivation } from '../dynamic/index.js'

export interface SmtpComponentArgs {
	env: Environment
	/** Postmark Server API Token, used as both SMTP username and password. */
	serverApiToken: string
	provider: zitadel.Provider
	/** Zitadel domain hosting the Admin API (e.g. `auth.dev.liverty-music.app`).
	 *  Required by `ZitadelSmtpActivation` for the post-create `_activate` call. */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON, used by `ZitadelSmtpActivation`
	 *  for Admin API auth (separate from the @pulumiverse provider). */
	jwtProfileJson: pulumi.Input<string>
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
	public readonly smtpActivation: ZitadelSmtpActivation

	constructor(
		name: string,
		args: SmtpComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:Smtp', name, {}, opts)

		const { env, serverApiToken, provider, domain, jwtProfileJson } = args
		const resourceOptions = { provider, parent: this }

		// Postmark uses the same Server API Token for both SMTP username and password.
		this.smtpConfig = new zitadel.SmtpConfig(
			'postmark',
			{
				senderAddress: senderAddressMap[env],
				senderName: 'Liverty Music',
				tls: true,
				host: 'smtp.postmarkapp.com:587',
				user: pulumi.secret(serverApiToken),
				password: pulumi.secret(serverApiToken),
			},
			resourceOptions,
		)

		// `@pulumiverse/zitadel.SmtpConfig` (v0.2.0) provisions the SMTP
		// configuration but does NOT call the separate `_activate` admin
		// endpoint that Zitadel v4 requires before SMTP traffic flows. Without
		// this Dynamic Resource, every Zitadel rebuild silently re-introduces
		// the cutover §13.16 incident (first-sign-up email verification
		// failing) until an operator remembers to run the `_activate` curl.
		this.smtpActivation = new ZitadelSmtpActivation(
			'smtp-activation',
			{
				domain,
				jwtProfileJson,
				smtpConfigId: this.smtpConfig.id,
			},
			{ parent: this, dependsOn: [this.smtpConfig] },
		)

		this.registerOutputs({
			smtpConfig: this.smtpConfig,
			smtpActivation: this.smtpActivation,
		})
	}
}
