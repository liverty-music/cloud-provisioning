import * as pulumi from '@pulumi/pulumi'
import * as zitadel from '@pulumiverse/zitadel'
import type { Environment } from '../../config.js'
import { ZitadelHumanUserPasswordPermanent } from '../dynamic/permanent-password.js'

export interface E2eTestUserComponentArgs {
	/** Pulumi stack environment. The component throws synchronously if
	 *  `env !== 'dev'` — the E2E test user is dev-only and the parent
	 *  `Zitadel` class also gates self-hosted topology to dev, so this
	 *  guard is defensive depth in case the component is ever lifted
	 *  out of the dev-only constructor. */
	env: Environment
	/** ID of the `liverty-music` product org. The E2E test user lives
	 *  alongside end-user identities; the product org's `LoginPolicy`
	 *  (see `components/frontend.ts`) currently has `userLogin = true`
	 *  which permits username + password sign-in. */
	orgId: pulumi.Input<string>
	/** Initial password for the test user. Source: ESC
	 *  `pulumiConfig.zitadel.e2eTestUser.password`. The caller wraps it
	 *  with `pulumi.secret()` when extracting from the parent
	 *  `requireSecretObject<>` so Pulumi marks it `[secret]` in state.
	 *  Threaded into BOTH the `HumanUser.initialPassword` field AND the
	 *  `ZitadelHumanUserPasswordPermanent` marker resource — they always
	 *  agree by construction. */
	initialPassword: pulumi.Input<string>
	/** Zitadel domain (e.g. `auth.dev.liverty-music.app`). Used by the
	 *  `ZitadelHumanUserPasswordPermanent` marker resource to call the
	 *  Management API. */
	domain: pulumi.Input<string>
	/** Admin machine user JWT profile JSON (stringified) for Management
	 *  API auth. Used by the `ZitadelHumanUserPasswordPermanent` marker
	 *  resource. Same value the `Zitadel` composition root reads from
	 *  GCP Secret Manager for the other dynamic resources. */
	jwtProfileJson: pulumi.Input<string>
	provider: zitadel.Provider
}

/**
 * E2eTestUserComponent provisions a single password-based HumanUser
 * in the `liverty-music` product org for use by Playwright headless
 * E2E tests.
 *
 * ## Why a separate user
 *
 * The existing dev test user is passkey-only. Passkey credentials
 * require a biometric/PIN gesture from the registered device and
 * cannot be replayed by headless Playwright. On WSL2 + WSLg the
 * headed-Chromium fallback (`capture-auth-state.ts`) cannot reliably
 * render the OS-level passkey UI either — Chromium opens but the
 * page stays at `about:blank` past the 5-minute polling timeout.
 *
 * A second user, authenticated by username + password, gives
 * headless Playwright a credential path it can drive end-to-end.
 * The passkey user is retained unchanged for device-bound manual
 * testing on display-capable hosts.
 *
 * See OpenSpec change `playwright-password-test-user` for the full
 * decision record (D1–D5) and risk table.
 *
 * ## Dependency on `LoginPolicy.userLogin = true`
 *
 * Password sign-in for this user depends on the product org's
 * `LoginPolicy.userLogin` flag being `true`. Today it IS true, but
 * only as a workaround for Zitadel upstream issue
 * https://github.com/zitadel/zitadel/issues/11682 (Login V2 Register
 * page does not render form fields when `userLogin = false`, even
 * with `passwordlessType = ALLOWED`). When that upstream fix lands
 * and the workaround is reverted, the e2e-test-user can no longer
 * authenticate with this approach. See the design.md risk row for
 * the three mitigation options at revert time.
 *
 * ## isEmailVerified + initialPassword
 *
 * The `@pulumiverse/zitadel.HumanUser` provider requires an
 * `initialPassword` to be present when `isEmailVerified = true`:
 *
 *   > Caution: Email can only be set verified if a password is set
 *   > for the user, either with initialPassword or during runtime.
 *
 * E2E demands a pre-verified email (no OTP step in headless flow),
 * and the password is the user's actual sign-in credential — so the
 * dual constraint is satisfied naturally here (unlike `human-admin`,
 * which sets a never-used random password).
 *
 * ## ignoreChanges on initialPassword
 *
 * `initialPassword` is marked `ignoreChanges` so a casual ESC-secret
 * edit does not silently trigger resource replacement, which would
 * (a) re-mint the password, (b) invalidate the captured Playwright
 * storage state without telling anyone, and (c) require a manual
 * `.auth/password.md` + `.auth/storageState.json` refresh dance.
 *
 * Intentional rotation requires:
 *   1. `pulumi up --replace` against this resource explicitly, AND
 *   2. update `.auth/password.md` (read fresh from ESC), AND
 *   3. regenerate `.auth/storageState.json` via the capture script.
 *
 * ## Permanent-password marker
 *
 * `@pulumiverse/zitadel.HumanUser` v0.2.0 sets the user's credential
 * state with `changeRequired = true` and exposes no knob to flip it.
 * Without an explicit `SetPassword(noChangeRequired = true)` call, the
 * user is redirected to `/ui/v2/login/password/change` on first sign-in
 * and refuses to issue tokens until the password is changed. Headless
 * Playwright cannot tolerate this gate.
 *
 * Mitigation: `ZitadelHumanUserPasswordPermanent` (a Pulumi Dynamic
 * Resource under `../dynamic/permanent-password.ts`) calls the
 * Management API `POST /management/v1/users/{user_id}/password` with
 * `noChangeRequired: true` immediately after the HumanUser is created.
 * The same ESC password is threaded to both the HumanUser's
 * `initialPassword` and the marker resource — they agree by
 * construction. See OpenSpec change `zitadel-permanent-password` for
 * the full design + risk record.
 *
 * The marker mirrors the HumanUser's `ignoreChanges` on its password
 * input AND adds `replaceOnChanges: ['userId']` so that a `--replace`
 * on the HumanUser cascades into a fresh marker create (which picks up
 * the new password from create-time inputs, not from ignored state).
 * Net effect: the rotation protocol above remains a single
 * `--replace` on the HumanUser URN; the marker follows automatically.
 */
export class E2eTestUserComponent extends pulumi.ComponentResource {
	public readonly humanUser: zitadel.HumanUser
	public readonly passwordPermanent: ZitadelHumanUserPasswordPermanent

	constructor(
		name: string,
		args: E2eTestUserComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super('zitadel:liverty-music:E2eTestUser', name, {}, opts)

		const {
			env,
			orgId,
			initialPassword,
			domain,
			jwtProfileJson,
			provider,
		} = args

		// Defensive depth — the parent Zitadel class already throws on
		// non-dev, but this catches accidental refactors that lift the
		// component out of the dev-only constructor branch.
		if (env !== 'dev') {
			throw new Error(
				`E2eTestUserComponent: E2E test user is dev-only; got env=${env}. ` +
					'See OpenSpec change "playwright-password-test-user" for the rationale.',
			)
		}

		this.humanUser = new zitadel.HumanUser(
			'e2e-test-password',
			{
				orgId,
				// userName + email aligned so Login V2's username field accepts
				// the email directly. The `e2e-test-password@` local-part makes
				// the user immediately recognizable in the admin console list.
				userName: 'e2e-test-password@dev.liverty-music.app',
				email: 'e2e-test-password@dev.liverty-music.app',
				firstName: 'E2E',
				lastName: 'Password Test User',
				preferredLanguage: 'en',
				// Pre-verified so the headless OIDC flow does not hit the
				// Self-Registration OTP step. Paired with `initialPassword`
				// per the @pulumiverse/zitadel HumanUser constraint.
				isEmailVerified: true,
				initialPassword: pulumi.secret(initialPassword),
			},
			{
				provider,
				parent: this,
				// See header comment "ignoreChanges on initialPassword" for
				// the rotation protocol.
				ignoreChanges: ['initialPassword'],
			},
		)

		// Mark the password permanent (noChangeRequired = true) so first
		// sign-in does not redirect to /ui/v2/login/password/change. See
		// the header comment "Permanent-password marker" for the rationale.
		//
		// `ignoreChanges: ['password']` mirrors the HumanUser's
		// `ignoreChanges: ['initialPassword']` directive. Without it, an
		// ESC-secret edit would be ignored on the HumanUser (per the
		// rotation protocol above) but would silently trigger `update()`
		// on this marker, re-POSTing SetPassword with the new value to
		// Zitadel — silently rotating the live credential, exactly the
		// scenario the parent guard exists to prevent.
		//
		// `replaceOnChanges: ['userId']` ensures the marker is replaced
		// (destroyed + freshly created) when the HumanUser is replaced
		// via `pulumi up --replace`. The HumanUser's new snowflake id
		// flows into `userId` here; without this directive the marker
		// would call `update()` with the new userId but the old
		// (ignored) password, overwriting the freshly-rotated credential
		// with the stale value. With it, `create()` runs against the
		// new user with the new password — rotation works end-to-end
		// with a single `--replace` on the HumanUser URN.
		this.passwordPermanent = new ZitadelHumanUserPasswordPermanent(
			'e2e-test-password-permanent',
			{
				domain,
				jwtProfileJson,
				userId: this.humanUser.id,
				password: pulumi.secret(initialPassword),
			},
			{
				parent: this,
				dependsOn: [this.humanUser],
				ignoreChanges: ['password'],
				replaceOnChanges: ['userId'],
			},
		)

		this.registerOutputs({
			humanUser: this.humanUser,
			passwordPermanent: this.passwordPermanent,
		})
	}
}
