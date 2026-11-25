/**
 * Shared constants for the self-hosted Zitadel deployment.
 *
 * Kept in one file so that Service-name, port, and DNS conventions
 * shared between Pulumi resources and Kubernetes manifests are
 * impossible to drift apart silently.
 */

import type { Environment } from '../config.js'

/**
 * Per-environment base apex used for both the SPA hostnames and the
 * Zitadel issuer hostname. The frontend's redirect URIs are at
 * `https://${baseDomainMap[env]}` and the Zitadel issuer is at
 * `https://auth.${baseDomainMap[env]}`.
 */
export const baseDomainMap: Record<Environment, string> = {
	dev: 'dev.liverty-music.app',
	prod: 'liverty-music.app',
}

/**
 * Username of the password-based Playwright E2E test user per environment
 * (`E2eTestUserComponent`). It has the shape of an email address so Login V2's
 * username field accepts it, and the `e2e-test-password@` local-part keeps the
 * user recognizable in the console list. The tests sign in with it, so it stays
 * on the environment's base domain even though no mail is sent there.
 */
export const e2eTestUserNameMap: Record<Environment, string> = {
	dev: `e2e-test-password@${baseDomainMap.dev}`,
	prod: `e2e-test-password@${baseDomainMap.prod}`,
}

/**
 * Extra password-based E2E test users, for stories that need more than one
 * fan (one fan buys another's resale listing; two fans race for the last
 * one). Each slot is `e2e-test-password-<slot>@<base domain>`, with the same
 * password as the main E2E test user.
 */
export const e2eTestFanSlots = ['fan2', 'fan3'] as const

export type E2eTestFanSlot = (typeof e2eTestFanSlots)[number]

/** Username of the E2E test user of `slot` (the main user without one). */
export function e2eTestUserName(
	env: Environment,
	slot?: E2eTestFanSlot,
): string {
	return slot
		? `e2e-test-password-${slot}@${baseDomainMap[env]}`
		: e2eTestUserNameMap[env]
}

/**
 * Postmark's black hole domain: Postmark accepts mail sent there, drops it and
 * leaves it out of the bounce rate. The base domain has no MX record, so mail
 * to the E2E users there bounced, and with almost no real traffic those bounces
 * pushed the shared Postmark server far above its 10% bounce-rate limit, past
 * which Postmark pauses all sending.
 * https://postmarkapp.com/support/article/1213-best-practices-for-testing-your-emails-through-postmark
 */
const postmarkBlackHoleDomain = 'blackhole.postmarkapp.com'

/** Email of the E2E test user of `slot` (the main user without one). */
export function e2eTestUserEmail(
	env: Environment,
	slot?: E2eTestFanSlot,
): string {
	const envSuffix = env === 'prod' ? '' : `-${env}`
	const slotSuffix = slot ? `-${slot}` : ''
	return `e2e-test-password${slotSuffix}${envSuffix}@${postmarkBlackHoleDomain}`
}

/**
 * Zitadel issuer hostname per environment.
 *
 *     https://auth.dev.liverty-music.app
 *     https://auth.liverty-music.app
 */
export const zitadelDomainMap: Record<Environment, string> = {
	dev: `auth.${baseDomainMap.dev}`,
	prod: `auth.${baseDomainMap.prod}`,
}

/**
 * Cluster-internal URL of the backend webhook listener that Zitadel
 * Actions v2 Targets call.
 *
 * Must stay in sync with:
 *   - `k8s/namespaces/backend/base/fan-api/service-webhook.yaml` (Service name + port)
 *   - `k8s/namespaces/backend/base/fan-api/deployment.yaml` (containerPort 9090)
 *   - The backend's webhook listener in `infrastructure/server/webhook.go` (port + paths)
 *
 * unify-workload-naming: the webhook is served by the `fan-api` workload
 * (`fan-api-webhook-svc`), the audience-tier successor to `server-app`. Changing
 * this endpoint is an IN-PLACE Zitadel Target update (only a `payloadType` change
 * forces a replace — see `dynamic/target.ts` diff), so the login-event Target
 * keeps its HMAC `signingKey` and there is no GSM/ESO churn. Repointing this
 * completes the fan webhook cutover, so `server-webhook-svc` can then be retired
 * with the rest of the server workload.
 *
 * Path constants are appended by `actions-v2.ts` to form the final
 * Target endpoints. The `:9090` listener has no `authn.Middleware`;
 * each handler verifies the `PAYLOAD_TYPE_JWT` body against the
 * Zitadel JWKS and pins a per-endpoint `aud` claim.
 */
export const BACKEND_WEBHOOK_BASE_URL =
	'http://fan-api-webhook-svc.backend.svc.cluster.local:9090'
export const PRE_ACCESS_TOKEN_PATH = '/pre-access-token'
/** Backend login-event webhook path, bound to the Zitadel Actions v2 event
 *  execution on `session.user.checked`. The handler records the sign-in
 *  (User.RecordLogin), which announces `USER.signed_in`. */
export const LOGIN_EVENT_PATH = '/account-login-event'
/** Backend passkey-event webhook path, bound to the Zitadel Actions v2 event
 *  executions on `user.human.passwordless.token.verified` (passkey added) and
 *  `user.human.passwordless.token.removed` (passkey removed). The handler
 *  records the change, which announces `PASSKEY.added` or `PASSKEY.removed`
 *  so the fan is emailed about it.
 *  See OpenSpec change `fan-passkey-recovery-and-management`, design D6. */
export const PASSKEY_EVENT_PATH = '/passkey-event'
/** Backend password-setup-refusal webhook path, bound to the Zitadel Actions
 *  v2 request executions on the API methods that set the caller's own
 *  password. The handler never answers 2xx, so Zitadel refuses them. See
 *  OpenSpec change `remove-password-setup-from-hosted-login`, design D8. */
export const PASSWORD_SETUP_REFUSAL_PATH = '/refuse-password-setup'

/**
 * Bootstrap-created `admin` Role Org IDs per environment.
 *
 * Per OpenSpec change `add-zitadel-console-admin-via-google-idp`, each
 * Zitadel instance is split into two orgs:
 *   - `admin` role org — created by Zitadel at first-instance bootstrap
 *     because the configmap sets `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin`.
 *     Hosts the `pulumi-admin` machine user (used by Pulumi to authenticate)
 *     and human admins.
 *   - `liverty-music` product org — created by Pulumi via `zitadel.Org`.
 *     Hosts the product Project, ApplicationOidc, end-user LoginPolicy,
 *     `backend-app` machine user, and end-user accounts.
 *
 * Each id was discovered post-bootstrap via `POST /admin/v1/orgs/_search`
 * against the env's `pulumi-admin` machine user JWT (uploaded to GSM
 * `zitadel-machine-key-for-pulumi-admin` by the in-cluster
 * `bootstrap-uploader` sidecar). The values are stable across pod
 * restarts but instance-specific — if a Zitadel database is wiped and
 * re-bootstrapped, the corresponding entry MUST be updated to the new
 * admin org id before running `pulumi up` against the re-bootstrapped
 * instance.
 *
 *   dev:  captured 2026-05-03 after dev DB wipe + re-bootstrap
 *   prod: captured 2026-05-15 after prod first-boot bootstrap
 *
 * The unified `Zitadel` class (`src/zitadel/index.ts`) consumes this map
 * via `import: adminOrgIdMap[env]` on the `zitadel.Org('admin', ...)`
 * resource, bringing the bootstrap-created admin org into Pulumi state
 * across all envs without a per-env wrapper class.
 */
export const adminOrgIdMap: Record<Environment, string> = {
	dev: '371280364565496672',
	prod: '372892288692584603',
}
