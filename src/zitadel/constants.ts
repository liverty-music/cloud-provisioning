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

/**
 * Bootstrap-created Instance IDs per environment.
 *
 * Each id is the random snowflake assigned by Zitadel when `start-from-init`
 * provisions the first instance on an empty database. Unlike `adminOrgIdMap`
 * which is queried via Management API, instance ids are exposed via the
 * System API (`instance.v2.ListInstances`) and require a `SYSTEM_OWNER` JWT
 * to read.
 *
 * Consumed by `ZitadelInstanceCustomDomain` (the Pulumi Dynamic Resource that
 * registers `zitadel-api.zitadel.svc.cluster.local` so the Login UI's
 * cluster-internal `Host` header is accepted by the API). Without a valid
 * instance id, `AddCustomDomain` returns `invalid_argument`.
 *
 * **Discovery procedure** (one-time, after the corresponding env is first
 * bootstrapped, and only after the `pulumi-system` System User is in place
 * via `ZITADEL_SYSTEMAPIUSERS`):
 *
 *   1. Have Pulumi read the private key from GSM `zitadel-system-api-key`
 *      and sign a short-lived JWT (or run an ad-hoc Node script that
 *      reproduces `buildSystemAssertion` from
 *      `src/zitadel/dynamic/api-client.ts`).
 *   2. `curl -X POST https://auth.<env>.liverty-music.app/zitadel.instance.v2.InstanceService/ListInstances \
 *        -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}'`
 *   3. Pick the (single, self-hosted) instance's `id`. Update the entry
 *      below and commit.
 *
 * If a Zitadel database is wiped and re-bootstrapped (e.g. dev shutdown +
 * Cloud SQL restore), the new instance id MUST be captured and committed
 * here before the corresponding `pulumi up` runs — otherwise the Dynamic
 * Resource will fail to register the domain.
 *
 * **Placeholder** values below indicate the env's instance id has not yet
 * been captured. `ZitadelInstanceCustomDomain` will fail-fast at apply
 * time if it sees `__UNSET__`, surfacing the missing-bootstrap-capture
 * step rather than emitting a confusing "invalid_argument" from Zitadel.
 *
 * Introduced by OpenSpec change `route-login-v2-via-internal-zitadel-api`.
 */
export const instanceIdMap: Record<Environment, string> = {
	// dev is currently shut down (`liverty-music:workloadEnabled: "false"` in
	// Pulumi.dev.yaml). The dev Zitadel instance is destroyed, so there is
	// no instance id to discover. The `__UNSET__` sentinel is harmless
	// here because the `ZitadelInstanceCustomDomain` resource is gated on
	// `workloadEnabled && zitadel !== undefined` in `src/index.ts` and
	// is NOT instantiated when workloads are disabled. When dev is brought
	// back up (procedure B in docs/runbooks/dev-shutdown-restart.md), the
	// operator MUST run `node scripts/discover-zitadel-instance-id.mjs
	// --env=dev` and commit the captured id here BEFORE the next
	// `pulumi up` would otherwise hit the Dynamic Resource's fail-fast
	// guard.
	dev: '__UNSET__',
	// Captured 2026-05-20 after Phase 1 deployed on prod and the
	// `pulumi-system` System User was loaded on the `zitadel-api` Pod.
	// Verified via
	// `node scripts/discover-zitadel-instance-id.mjs --env=prod`.
	prod: '372892288692519067',
}

/**
 * The System API user name declared via the Zitadel API container's
 * `ZITADEL_SYSTEMAPIUSERS` env. Must match the JSON key in that env value
 * AND the file basename of the projected public key. Single source of
 * truth — referenced by both Pulumi (for JWT `iss`/`sub` claims) and the
 * k8s manifest comment block in `deployment-api.yaml`.
 */
export const SYSTEM_API_USER_NAME = 'pulumi-system'

/**
 * The cluster-internal hostname registered as an InstanceCustomDomain so
 * the Login UI's outbound Connect-RPC calls (with `Host:
 * zitadel-api.zitadel.svc.cluster.local`) reach the API without
 * traversing the public Gateway hairpin. Must match the K8s Service
 * `zitadel-api` in the `zitadel` namespace.
 */
export const ZITADEL_API_INTERNAL_HOST = 'zitadel-api.zitadel.svc.cluster.local'
