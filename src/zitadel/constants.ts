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
 *   - `k8s/namespaces/backend/base/server/service-webhook.yaml` (Service name + port)
 *   - `k8s/namespaces/backend/base/server/deployment.yaml` (containerPort 9090)
 *   - The backend's webhook listener in `infrastructure/server/webhook.go` (port + paths)
 *
 * Path constants are appended by `actions-v2.ts` to form the final
 * Target endpoints. The `:9090` listener has no `authn.Middleware`;
 * each handler verifies the `PAYLOAD_TYPE_JWT` body against the
 * Zitadel JWKS and pins a per-endpoint `aud` claim.
 */
export const BACKEND_WEBHOOK_BASE_URL =
	'http://server-webhook-svc.backend.svc.cluster.local:9090'
export const PRE_ACCESS_TOKEN_PATH = '/pre-access-token'
/** Backend login-event webhook path — the account.login source, bound to the
 *  Zitadel Actions v2 event execution on `session.user.checked`. */
export const LOGIN_EVENT_PATH = '/account-login-event'

/**
 * Bootstrap-created `admin` Role Org IDs per environment.
 *
 * Per OpenSpec change `add-zitadel-console-admin-via-google-idp`, each
 * Zitadel instance is split into two orgs:
 *   - `admin` role org — created by Zitadel at first-instance bootstrap
 *     because the configmap sets `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin`.
 *     Hosts the `pulumi-admin` machine user (used by Pulumi to authenticate),
 *     the `login-client` machine user (Login V2 PAT host), and human admins.
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
