# Workload Rename — Create-New → Cutover → Delete-Old Runbook

Canonical procedure for renaming a platform workload (and every resource bound to
it) to the `<audience>-<tier>` naming convention. See the
`workload-naming-convention` spec for the scheme itself; this runbook captures the
**migration mechanics** so a live, route-bound, state-tracked workload moves without
a stuck-replace cascade or a routing gap.

## Golden rule

Never rename a live workload or a state-tracked / route-bound resource in place.
Always: **create the new-named resource → repoint traffic/identity to it → verify →
delete the old**. In-place renames of Pulumi GSAs/secrets/SQL users trigger
destroy/create replace cascades, and in-place HTTPRoute renames drop routing.
External hostnames NEVER change during a rename.

## Naming convention (quick reference)

`<audience>-<tier>` — `audience ∈ {fan, admin-console, organizer-console}`,
`tier ∈ {web, api, event-consumer}`.

| Concern | Name pattern |
|---|---|
| Workload (Deployment) | `<stem>` = `<audience>-<tier>` |
| Service | `<stem>-svc` |
| HealthCheckPolicy | `<stem>-policy` |
| HTTPRoute | `<stem>-route` |
| ExternalSecret | `<stem>-secrets` |
| ConfigMap | `<stem>-config` |
| GSA account-id | `<stem>` |
| Cloud SQL IAM user | `<stem>@<project>.iam` |
| Zitadel MachineKey GSM secret | `zitadel-machine-key-for-<stem>` |
| Artifact Registry repo | `<layer>/<stem>` (`layer ∈ {backend, frontend}`) |

## Canonical name mapping

| Current | Target | Kind |
|---|---|---|
| `web-app` | `fan-web` | frontend |
| `server-app` | `fan-api` | backend |
| `consumer-app` | `event-consumer` | worker |
| `admin-app` | `admin-console-web` | frontend |
| `admin-console-api` | `admin-console-api` (already conforms) | backend |
| `organizer-app` | `organizer-console-web` | frontend |
| `organizer-console-api` | built new under canonical name | backend |
| GSA `backend-app` | GSA `fan-api` | GCP identity |
| GSM `zitadel-machine-key-for-backend-app` | `zitadel-machine-key-for-fan-api` | secret |
| ExternalSecret `admin-console-secrets` | `admin-console-api-secrets` | secret |

## Per-resource-class migration order

Migrate **one audience at a time, dev first then prod**, so any failure is contained
to one surface. Within an audience:

### 1. Identity + infra (Pulumi, additive)

Stand up the new-named GCP identities alongside the old (old stays live):

- **GSA** — create `<stem>` GSA and replicate the **full** binding set from the old
  GSA before any cutover: `cloudsql.client` + `cloudsql.instanceUser`, logging /
  monitoring / cloudtrace / aiplatform / serviceusage, Artifact Registry reader,
  Workload Identity binding, and every per-secret SecretAccessor binding. A missing
  `cloudsql.client` / DB user / schema grant crashloops the pod — replicate the
  entire set, do not cherry-pick.
- **Cloud SQL IAM user** — add the `CLOUD_IAM_SERVICE_ACCOUNT` user
  `<stem>@<project>.iam` (`postgres.ts`); keep the old user live.
- **Zitadel MachineKey** — re-issue the old principal's MachineKey under the new
  principal into GSM `zitadel-machine-key-for-<stem>`; keep the old secret live.
- **Artifact Registry** — create `<layer>/<stem>` repos; keep the old repos live.
- For lifecycle-sensitive Pulumi URN renames where an in-place adopt is preferable to
  destroy/create, use `aliases: [{ name: 'old-urn' }]` rather than a rename.

`pulumi up` (dev, then prod).

### 2. Images + DB grants

- Point CI push targets at the new AR repos (+ the prod retag map); add the new
  repos to the `bump-prod-pin` image list.
- Run the app-schema grant migration (grant-loop) for the new IAM DB user **before**
  flipping `DATABASE_USER` — the new user has no grants until then.
- Cut releases to populate the new AR repos (dual-published while old is still live).

### 3. K8s create-new

Add new-named Deployment / Service (`<stem>-svc`) / ServiceAccount / HTTPRoute
(`<stem>-route`) / HealthCheckPolicy (`<stem>-policy`) / ConfigMap (`<stem>-config`) /
ExternalSecret (`<stem>-secrets`) / ScaledObject / PodMonitoring **alongside** the
old. Set the new `DATABASE_USER=<stem>@<project>.iam` where applicable. Let ArgoCD
sync. The renamed canonical names MUST be present in the rendered tree before prod
ArgoCD picks them up.

### 4. Cutover

Repoint each HTTPRoute (hostname unchanged) + `DATABASE_USER` + secret refs +
monitoring `app.kubernetes.io/name` labels to the new workload. Update the frontend
`verify-bundle-isolation` allowlist in lockstep. Verify: HTTP 200 on the (unchanged)
hostname + DB connect + Zitadel JWT auth + bundle isolation + HPA `currentMetrics`
not `<unknown>` for workers.

### 5. Delete-old

Remove old Deployments / Services / routes / secrets / configmaps, then the old GSA /
DB user / GSM key / AR repos. `pulumi up`. Confirm no dangling references.

### 6. Rollback

Until step 5, the old-named resources are still live and traffic-detached but intact
— repoint routes / env back to them. The new resources are additive and removable.

## Resource-class specifics

- **JetStream worker (`consumer-app` → `event-consumer`)** — rename only the
  Deployment / Service / ScaledObject / image. **Keep the JetStream durable names
  unchanged** — renaming durables wedges consumers. Verify HPA `currentMetrics` is
  not `<unknown>` and events still drain.
- **Monitoring** — PromQL / dashboards / AlertPolicies keyed on the old workload name
  go blind after cutover. Update them in the same change and verify metrics resolve.
- **AR image repos** — prod pin / immutable-tag retag / bump-prod-pin dispatch list
  all reference the old repo. Create new repos, update CI + pin list + release retag
  map, cut a release to populate, then repoint the overlays' `images:` block.
