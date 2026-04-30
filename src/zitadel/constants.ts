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
 *
 * dev is the only environment served by self-hosted Zitadel today
 * (per OpenSpec D10 cooldown plan); staging / prod entries are present
 * so that `frontend.ts` redirect URI computation continues to work
 * across environments without duplicating the table.
 */
export const baseDomainMap: Record<Environment, string> = {
	dev: 'dev.liverty-music.app',
	staging: 'staging.liverty-music.app',
	prod: 'liverty-music.app',
}

/**
 * Zitadel issuer hostname per environment.
 *
 *     https://auth.dev.liverty-music.app
 *     https://auth.staging.liverty-music.app   (future)
 *     https://auth.liverty-music.app           (future)
 */
export const zitadelDomainMap: Record<Environment, string> = {
	dev: `auth.${baseDomainMap.dev}`,
	staging: `auth.${baseDomainMap.staging}`,
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

/**
 * Default Organization ID assigned by Zitadel at first-instance bootstrap.
 *
 * Discovered post-bootstrap via `GET /auth/v1/users/me` against the
 * machine user that bootstrap-uploader writes to GSM
 * (`zitadel-admin-sa-key`). The value is stable across pod restarts
 * but instance-specific — if the dev Zitadel database is wiped and
 * re-bootstrapped, this constant must be updated.
 *
 * Hardcoded for dev because cutover is dev-only (OpenSpec D10).
 * Staging / prod migrations must extend this with an env-keyed map or
 * a Dynamic Resource that discovers the orgId from the admin SA key.
 */
export const ZITADEL_DEV_DEFAULT_ORG_ID = '369968599999251129'
