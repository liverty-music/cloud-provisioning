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
 * Bootstrap-created `admin` Role Org ID for the dev environment.
 *
 * Per OpenSpec change `add-zitadel-console-admin-via-google-idp`, the
 * Zitadel instance is split into two orgs:
 *   - `admin` role org — created by Zitadel at first-instance bootstrap
 *     because the configmap sets `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin`.
 *     Hosts the `pulumi-admin` machine user (used by Pulumi to authenticate),
 *     the `login-client` machine user (Login V2 PAT host), and human admins.
 *   - `liverty-music` product org — created by Pulumi via `zitadel.Org`.
 *     Hosts the product Project, ApplicationOidc, end-user LoginPolicy,
 *     `backend-app` machine user, and end-user accounts.
 *
 * The id below is the dev environment's `admin` org id, discovered
 * post-bootstrap via `POST /admin/v1/orgs/_search` against the machine
 * user whose JSON key the bootstrap-uploader sidecar writes to GSM
 * (`zitadel-admin-sa-key`). The value is stable across pod restarts but
 * instance-specific — if the dev Zitadel database is wiped and
 * re-bootstrapped, this constant MUST be updated to the new admin org id
 * before running `pulumi up` against the re-bootstrapped instance.
 *
 * Captured 2026-05-03 after the dev DB wipe + re-bootstrap step in
 * tasks.md Section 5: configmap.env now sets
 * `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin`, so this id refers to the org
 * named `admin` (verified via `POST /admin/v1/orgs/_search`). Staging /
 * prod adoption (separate change) extends this with an env-keyed map
 * or a Dynamic Resource that discovers the orgId from the admin SA key.
 */
export const ZITADEL_DEV_ADMIN_ORG_ID = '371280364565496672'
