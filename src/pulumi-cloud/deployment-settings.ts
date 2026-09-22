import * as pulumi from '@pulumi/pulumi'
import * as pulumiservice from '@pulumi/pulumiservice'
import type { Environment } from '../config.js'

/** GitHub repository holding this Pulumi program. */
const REPOSITORY = 'liverty-music/cloud-provisioning'

/**
 * Paths that may trigger a deployment, shared by every stack.
 *
 * THIS LIST IS A SECURITY CONTROL, NOT A PERFORMANCE KNOB.
 *
 * A preview runs `npm ci` and then executes this program, and the program
 * resolves production provider credentials from ESC at stack load
 * (`Pulumi.<stack>.yaml` → `environment:`). `skipInstallDependencies` is left
 * at its default of `false`, so the dependency tree of whatever pull request
 * triggered the preview is installed and executed with those credentials.
 *
 * What may trigger a preview therefore decides *whose code* runs with them.
 *
 * DO NOT ADD `package.json` OR `package-lock.json`.
 *
 * It is a reasonable-looking change to make — a dependency bump does alter
 * what this program does, so previewing it looks like an improvement. It is
 * not. Renovate pushes its branches INSIDE this repository, so GitHub's fork
 * protections do not apply to them. Adding those files here would mean every
 * automated dependency-update pull request executes a just-published,
 * unreviewed third-party package against production credentials before any
 * person has read it.
 *
 * Renovate pull requests touch only those two manifest files, so leaving them
 * out is the whole of what keeps them from being previewed. Nothing else
 * enforces it — a GitHub Actions `if:` condition cannot govern this trigger,
 * because this trigger is not GitHub Actions.
 *
 * See the OpenSpec change `automate-dependency-updates`, design D6.
 */
const SHARED_TRIGGER_PATHS = ['src/**']

/** Per-stack configuration file. Stack config is program input: a pull
 * request editing only this file changes what would be deployed, so it has to
 * trigger a preview like any source change. */
const stackConfigPath = (env: Environment) => `Pulumi.${env}.yaml`

export interface DeploymentSettingsComponentArgs {
	/** Pulumi Cloud organization that owns the stack. */
	organization: pulumi.Input<string>
	/** Pulumi project name, as declared in `Pulumi.yaml`. */
	project: pulumi.Input<string>
	/** Stack this component configures — always the stack it runs in. */
	environment: Environment
	/** GCP project number the deployment exchanges its OIDC token against. */
	gcpProjectNumber: pulumi.Input<string>
	/** Service account the deployment impersonates in that project. */
	gcpServiceAccount: pulumi.Input<string>
	/**
	 * Run `pulumi up` when a commit lands on the deploy branch.
	 *
	 * `true` for dev only. prod is applied deliberately from the Pulumi Cloud
	 * console — see CLAUDE.md, "Pulumi Deployments (Automated)".
	 */
	deployCommits?: boolean
}

/**
 * DeploymentSettingsComponent declares this repository's Pulumi Cloud
 * Deployments configuration as code, rather than leaving it in the Pulumi
 * Cloud console.
 *
 * Every stack previews its pull requests (`previewPullRequests: true`), which
 * is what makes an infrastructure change reviewable before it lands. That was
 * already true before this component existed — but only as console state, so
 * the trigger `paths` carrying the D6 control could be changed with no diff,
 * no review and no record. Declaring it here puts it behind the same gate as
 * any other change to this repository.
 *
 * Each stack manages its own settings, matching how the rest of this program
 * is scoped (`environment: env`).
 */
export class DeploymentSettingsComponent extends pulumi.ComponentResource {
	public readonly settings: pulumiservice.DeploymentSettings

	constructor(
		args: DeploymentSettingsComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super(
			'liverty-music:pulumi-cloud:DeploymentSettings',
			`deployment-settings-${args.environment}`,
			{},
			opts,
		)

		this.settings = new pulumiservice.DeploymentSettings(
			`deployment-settings-${args.environment}`,
			{
				organization: args.organization,
				project: args.project,
				stack: args.environment,
				sourceContext: {
					git: {
						// NO `repoUrl` HERE. The two VCS fields impose opposite
						// requirements on it and the API enforces both:
						//
						//   vcs:    400 `repoUrl cannot be empty`
						//   github: 400 `sourceContext.git.repoUrl cannot be
						//               specified when using GitHub integration`
						//
						// Under `github` the integration carries the repository
						// itself, which is also why `pulumi deployment settings
						// pull` emits no `repoUrl` — the pulled YAML was right and
						// adding one to satisfy `vcs` is what broke it.
						branch: 'main',
					},
				},
				// `github` is DEPRECATED in favour of `vcs`, and is used anyway.
				//
				// `vcs` is the documented replacement and it does not work:
				// Pulumi Cloud accepts the resource, reports success, and never
				// registers the stack with its trigger dispatcher, so no pull
				// request is ever previewed. Nothing fails — the deployments
				// simply stop being created.
				//
				// Measured here, not inferred. Previews ran on every `src/**`
				// pull request until the `pulumi up` at 2026-09-22T06:00Z that
				// created this resource with `vcs`; after it, the stack's
				// deployment list contains no `github-pull-request` entry at
				// all, and the settings endpoint returns neither a `vcs` nor a
				// `gitHub` block. The resource's Pulumi state shows why: `vcs`
				// is in its INPUTS and absent from its OUTPUTS — the provider
				// sent it and the service did not keep it.
				//
				// Upstream: pulumi/pulumi-pulumiservice#754, open. Reverting to
				// `github` is the reported fix and the only one.
				//
				// DO NOT "modernise" this back to `vcs` because a deprecation
				// warning says to. `pulumi preview` cannot catch the mistake —
				// it diffs the program against its own inputs, and the inputs
				// are exactly what the service discards. Confirm the issue is
				// closed, then verify against the stack's deployment list that
				// a pull request actually previews.
				github: {
					repository: REPOSITORY,
					previewPullRequests: true,
					deployCommits: args.deployCommits ?? false,
					paths: [
						...SHARED_TRIGGER_PATHS,
						stackConfigPath(args.environment),
					],
				},
				operationContext: {
					// Workload Identity Federation — no stored Pulumi or GCP
					// credential. This is why no `PULUMI_ACCESS_TOKEN` secret is
					// needed anywhere for the preview to run.
					oidc: {
						gcp: {
							projectId: args.gcpProjectNumber,
							workloadPoolId: 'external-providers',
							providerId: 'pulumi-provider',
							serviceAccount: args.gcpServiceAccount,
						},
					},
				},
			},
			{ parent: this },
		)

		this.registerOutputs({ settings: this.settings })
	}
}
