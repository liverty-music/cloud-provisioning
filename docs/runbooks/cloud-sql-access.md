# Runbook: connect to Cloud SQL as a developer

> **Background:** `postgres-osaka` in both `liverty-music-dev` and
> `liverty-music-prod` is reachable only through Private Service Connect.
> It has no public or private IP, so a `cloud-sql-proxy` on a laptop
> cannot reach it. Developers connect through a short-lived Cloud SQL
> Auth Proxy Pod inside the GKE cluster
> ([`k8s/tools/db-proxy/`](../../k8s/tools/db-proxy/)). They reach it
> with `kubectl port-forward` and log in **as their own Cloud SQL IAM
> user**, so audit logs and `pg_stat_activity` name the person. See
> OpenSpec change `unify-cloud-sql-access`.

This is the only supported way for a person to reach a Cloud SQL
instance. The same manifest and commands work in dev and prod; only the
overlay differs.

## When to use this runbook

- Ad-hoc read-only queries, schema inspection or data debugging in dev
  or prod.
- Break-glass writes as the `postgres` superuser (see
  [Break-glass login as `postgres`](#break-glass-login-as-postgres)).

For integration tests and local development, use the Docker Compose
Postgres in the backend repository instead.

## How it works

- The `db-proxy` Pod runs as KSA `backend/db-proxy`. Through Workload
  Identity, that KSA maps to GSA `db-proxy@liverty-music-<env>.iam.gserviceaccount.com`.
  The GSA holds only `roles/cloudsql.client`: it can open a connection
  but has no Cloud SQL user, so it can never log in.
- The proxy runs with `--psc` and **without** `--auto-iam-authn`. It
  authorizes and encrypts the connection; your client sends the
  username and password.
- The proxy listens on `127.0.0.1:5432` inside the Pod, so only
  `kubectl port-forward` can reach it.
- The Pod is not managed by ArgoCD. It ends itself after two hours
  (`activeDeadlineSeconds: 7200`) and runs on Spot, so a preemption also
  ends it.
- Human IAM users are **read-only** on the `app` schema (`USAGE` and
  `SELECT` on tables and sequences, plus default privileges for future
  tables). Writes go through the `postgres` break-glass login.

## Prerequisites

You need:

- `gcloud`, `kubectl` (with `gke-gcloud-auth-plugin`) and `psql`.
- Cluster credentials with permission to create Pods in the `backend`
  namespace (cluster admin today):
  - prod: [`prod-cluster-credentials.md`](prod-cluster-credentials.md)
    (`gcloud container clusters get-credentials autopilot-cluster-osaka --region asia-northeast2 --project liverty-music-prod`)
  - dev: `gcloud container clusters get-credentials standard-cluster-osaka --zone asia-northeast2-a --project liverty-music-dev`.
    Dev runs only while `workloadEnabled` is true; see
    [`dev-shutdown-restart.md`](dev-shutdown-restart.md).
- A Cloud SQL IAM user for your Google account, with
  `roles/cloudsql.instanceUser` on the project. Both come from the ESC
  list `gcp.cloudSqlUsers` (see
  [Adding a developer](#adding-a-developer)).
- `gcloud auth login` as that same account. `generate-login-token` uses
  the active gcloud account.

## Connect

Run from the cloud-provisioning repository root, with `kubectl` pointed
at the target cluster and `ENV` set to `dev` or `prod`.

```bash
ENV=prod

# 1. Create the proxy Pod (and its KSA).
kubectl apply -k k8s/tools/db-proxy/overlays/$ENV
kubectl wait --for=condition=Ready pod/db-proxy -n backend --timeout=5m

# 2. Forward the port. Keep this terminal open.
kubectl port-forward pod/db-proxy 5432:5432 -n backend

# 3. In another terminal, log in as yourself with a short-lived token.
PGPASSWORD=$(gcloud sql generate-login-token) psql \
  "host=127.0.0.1 port=5432 dbname=liverty-music sslmode=disable options='-c search_path=app' user=$(gcloud config get-value account)"

# 4. When done, delete the Pod.
kubectl delete -k k8s/tools/db-proxy/overlays/$ENV
```

On Autopilot (prod), the first `apply` may take a minute or two while a
Spot node is provisioned.

### Connection parameters

| Parameter | Value |
|-----------|-------|
| Host | `127.0.0.1` (through `port-forward`) |
| Port | `5432` |
| User | your full Google account email, e.g. `pannpers@pannpers.dev` |
| Password | `$(gcloud sql generate-login-token)` |
| Database | `liverty-music` |
| Schema | `app` (`options='-c search_path=app'`) |
| SSL mode | `disable`; the proxy already encrypts the connection |

GUI clients (DBeaver, TablePlus, etc.) use the same values. Paste a
freshly generated token as the password.

### Token expiry

A login token is valid for about one hour. It only matters when a
**new** connection is opened: an open session keeps working after the
token expires. Before reconnecting, run `gcloud sql generate-login-token`
again. In GUI clients, update the saved password.

## Break-glass login as `postgres`

Use the built-in `postgres` superuser only for writes or DDL that the
read-only IAM login cannot do, such as a manual data fix,
`DROP`/`CREATE DATABASE` during
[Zitadel recovery](zitadel-break-glass.md#b-pulumi-admin-user-deleted-from-zitadel-no-sa-key-valid),
or verifying a rotated admin password. It uses the same Pod; only the
login differs.

```bash
kubectl apply -k k8s/tools/db-proxy/overlays/$ENV
kubectl wait --for=condition=Ready pod/db-proxy -n backend --timeout=5m
kubectl port-forward pod/db-proxy 5432:5432 -n backend &

# The password is the ESC value gcp.postgresAdminPassword, mirrored to GSM.
PGPASSWORD=$(gcloud secrets versions access latest \
  --project=liverty-music-$ENV --secret=postgres-admin-password) \
  psql "host=127.0.0.1 port=5432 dbname=liverty-music sslmode=disable user=postgres"

kubectl delete -k k8s/tools/db-proxy/overlays/$ENV
```

Connect to `dbname=postgres` instead when the target database itself
must be dropped. Do not stay logged in as superuser longer than needed.

## Adding a developer

1. Add the person's Google account email to the ESC list
   `pulumiConfig.gcp.cloudSqlUsers` in `liverty-music/<env>`.
2. Apply it: prod through the Pulumi Cloud console; dev by merging a PR
   (dev `pulumi up` runs automatically). This creates the
   `CLOUD_IAM_USER` and grants `roles/cloudsql.instanceUser`.
3. Log in as `postgres` ([break-glass](#break-glass-login-as-postgres))
   and run the read-only grant once. It is the same block as the backend
   migration, and it is idempotent:

   ```sql
   DO $$
   DECLARE
     human_role TEXT;
   BEGIN
     -- Human IAM users only: emails, but not Workload Identity SAs (*.iam).
     FOR human_role IN
       SELECT rolname FROM pg_roles
       WHERE rolname LIKE '%@%' AND rolname NOT LIKE '%.iam'
     LOOP
       EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', human_role);
       EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA app TO %I', human_role);
       EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA app TO %I', human_role);
       EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO %I', human_role);
       EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON SEQUENCES TO %I', human_role);
     END LOOP;
   END
   $$;
   ```

4. Have the developer follow [Connect](#connect) and check that
   `SELECT` works and `INSERT` fails with `permission denied`.

They also need cluster credentials that allow creating Pods in the
`backend` namespace.

## Cleanup and troubleshooting

- **Always** `kubectl delete -k k8s/tools/db-proxy/overlays/$ENV` when
  done. A forgotten Pod ends after two hours anyway.
- `kubectl get pod db-proxy -n backend` shows `Failed` with reason
  `DeadlineExceeded` after two hours. Delete it and apply again.
- `password authentication failed for user "<email>"`: the token is
  expired or was generated for another gcloud account. Check
  `gcloud config get-value account` and generate a new token.
- `role "<email>" does not exist`: the Cloud SQL IAM user is missing.
  See [Adding a developer](#adding-a-developer).
- `permission denied for table ...` on `SELECT`: the read-only grant has
  not run for your role. Run step 3 of
  [Adding a developer](#adding-a-developer).
- Proxy logs: `kubectl logs pod/db-proxy -n backend`.

## See also

- [`k8s/tools/db-proxy/`](../../k8s/tools/db-proxy/): the manifest.
- [`zitadel-break-glass.md`](zitadel-break-glass.md): uses this Pod for
  the `zitadel` database rescue.
- [`setup-prod-credentials.md`](setup-prod-credentials.md) §4: the
  `postgres` admin password.
