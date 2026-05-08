# Runbook: Zitadel Console break-glass recovery

> **When to use:** the human admin (Google SSO) cannot reach
> `https://auth.dev.liverty-music.app/ui/console` for any reason — IdP
> outage, accidentally-deleted Google OAuth client, broken admin
> `LoginPolicy`, deleted human-admin `HumanUser`, broken `IdpGoogle`
> resource, mangled `ZitadelUserIdpLink`. This runbook walks the
> machine-user (`pulumi-admin`) recovery path so the operator can
> repair Zitadel state via Pulumi without going through the human
> sign-in flow.

## Background — why two independent identities exist

The dev Zitadel instance has **two paths** to authenticate
infrastructure changes:

1. **Human admin** (`pannpers@pannpers.dev`, `IAM_OWNER`) — Google SSO
   → Console UI. The everyday path. Depends on Google IdP, the OAuth
   client, the admin org's `LoginPolicy`, the `IdpGoogle` Pulumi
   resource, and the `ZitadelUserIdpLink` pre-link. Many moving parts.
2. **Machine admin** (`pulumi-admin`, `IAM_OWNER`) — JSON service
   account key in GSM secret `zitadel-admin-sa-key` → JWT-bearer
   exchange → Zitadel admin REST API. The `@pulumiverse/zitadel`
   Pulumi provider is the typical consumer. Depends on **only** the
   GSM secret + Cloud SQL eventstore being intact.

Path 2 is the break-glass identity. It survives any failure of path 1
because Pulumi's `liverty-music-provider` reads the SA key directly
from GSM and talks to Zitadel without going through Login V2 or any
IdP. See OpenSpec change `add-zitadel-console-admin-via-google-idp`
spec requirement *"Retain Break-glass Machine User"*.

## Pre-conditions for break-glass to work

Verify these before relying on the runbook (if any are broken, the
break-glass path itself is compromised — see [Recovering the
break-glass identity itself](#recovering-the-break-glass-identity-itself)):

```bash
# 1. The pulumi-admin user still exists in the admin org.
PROJECT=liverty-music-dev
gcloud secrets versions access latest --secret=zitadel-admin-sa-key \
  --project="$PROJECT" > /tmp/zitadel-admin-sa-key.json
jq -r '.userId' /tmp/zitadel-admin-sa-key.json
# expected: a Zitadel user-id snowflake (numeric string)

# 2. The Cloud SQL eventstore is reachable.
kubectl -n zitadel get pods -l app=zitadel
# expected: zitadel-* pod Running 3/3 (zitadel + cloud-sql-proxy + bootstrap-uploader)
```

## Break-glass procedure

### Step 1 — fetch the SA key locally

```bash
gcloud secrets versions access latest --secret=zitadel-admin-sa-key \
  --project=liverty-music-dev > /tmp/zitadel-admin-sa-key.json
```

The file contains the `pulumi-admin` machine user's RSA private key.
Treat it like a root credential — delete from `/tmp` after use, do not
commit, do not paste anywhere.

### Step 2 — confirm the SA key authenticates against Zitadel

A short Python script using only the standard library plus
`cryptography` to mint a JWT-bearer assertion, exchange it for a
Zitadel access token, and call a sanity endpoint:

```python
#!/usr/bin/env python3
import json, time, urllib.request
from base64 import urlsafe_b64encode
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ZITADEL = "https://auth.dev.liverty-music.app"

def b64url(d): return urlsafe_b64encode(d).rstrip(b"=").decode()
with open("/tmp/zitadel-admin-sa-key.json") as f: key = json.load(f)
now = int(time.time())
header = {"alg":"RS256","typ":"JWT","kid":key["keyId"]}
payload = {"iss":key["userId"],"sub":key["userId"],"aud":ZITADEL,"iat":now,"exp":now+300}
h = b64url(json.dumps(header,separators=(",",":")).encode())
p = b64url(json.dumps(payload,separators=(",",":")).encode())
sig = serialization.load_pem_private_key(key["key"].encode(), password=None).sign(
    f"{h}.{p}".encode(), padding.PKCS1v15(), hashes.SHA256())
body = (
    "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer"
    f"&assertion={h}.{p}.{b64url(sig)}"
    "&scope=openid urn:zitadel:iam:org:project:id:zitadel:aud"
)
req = urllib.request.Request(f"{ZITADEL}/oauth/v2/token", data=body.encode(),
    headers={"Content-Type":"application/x-www-form-urlencoded"}, method="POST")
token = json.loads(urllib.request.urlopen(req).read())["access_token"]

# Sanity: list orgs (IAM_OWNER required).
req = urllib.request.Request(f"{ZITADEL}/admin/v1/orgs/_search",
    headers={"Authorization": f"Bearer {token}", "Content-Type":"application/json"},
    data=b"{}", method="POST")
print(json.loads(urllib.request.urlopen(req).read()))
```

Save as `/tmp/zitadel-break-glass-smoke.py`, then `python3
/tmp/zitadel-break-glass-smoke.py`.

**Expected output:** a JSON envelope listing `admin` and
`liverty-music` orgs. If the call returns 401/403, the SA key is
invalid — see [Recovering the break-glass identity
itself](#recovering-the-break-glass-identity-itself).

### Step 3 — let Pulumi take over

The `@pulumiverse/zitadel` provider reads `zitadel-admin-sa-key` from
GSM directly via `gcp.secretmanager.getSecretVersionOutput` (see
[`src/zitadel/index.ts`](../../src/zitadel/index.ts) — the
`jwtProfileJson` wiring). No additional config is needed; running
Pulumi commands against the `dev` stack uses this same path.

```bash
cd ~/dev/src/github.com/liverty-music/cloud-provisioning

# Confirm Pulumi can talk to Zitadel — empty diff proves the key works.
pulumi preview -s dev
# expected: "no changes" or only resources unrelated to identity
```

If `preview` succeeds, **everyday Pulumi flow is back online**. From
this point you can:

- Re-create a deleted `HumanUser` / `InstanceMember` /
  `ZitadelUserIdpLink` by reverting the offending PR or `pulumi up`.
- Re-create a deleted `IdpGoogle` by `pulumi up` (ESC carries
  `clientId` / `clientSecret`; the IdP is fully declarative).
- Re-create a deleted `LoginPolicy` on the admin org by `pulumi up`
  (`AdminOrgConfigComponent`).

### Step 4 — restore Console access

After Pulumi reconciles the broken resources:

1. Wait for `pulumi up` to complete (or the Pulumi Cloud auto-deploy
   on PR merge if you are routing through CI).
2. Test `https://auth.dev.liverty-music.app/ui/console` in a private
   window. The Google SSO path should resolve to the human admin and
   load Console with `IAM_OWNER`.
3. If the smoke test still fails, check the IdP link via the API:
   ```bash
   python3 /tmp/list-pannpers-idp-links.py   # see add-zitadel-admin-user.md
   ```
   `result[]` must contain a link with `idpId` matching the Google IdP
   id and `userId` matching the ESC-stored Google `sub`.

## Recovering the break-glass identity itself

The break-glass path **fails** if any of the following are broken:

- The `zitadel-admin-sa-key` GSM secret is missing or corrupt.
- The `pulumi-admin` user is gone from Zitadel (someone deleted it
  through the Console or ran `DELETE /management/v1/users/<id>`).
- The `eventstore` schema in Cloud SQL is corrupt.

### A. SA key missing or corrupt in GSM but pulumi-admin still in Zitadel

**The bootstrap-uploader sidecar does NOT help here.** It only fires
during the *first* boot of an empty Zitadel database — Zitadel writes
the admin SA key to the `emptyDir` bootstrap volume only when
`FIRSTINSTANCE_*` runs. On any restart against a populated DB the
volume is wiped, the file is never recreated, and the sidecar's
`while [ ! -f "$KEY_FILE" ]; do sleep 2; done` loop blocks forever.
See [`k8s/namespaces/zitadel/base/deployment-api.yaml#L122-L148`](../../k8s/namespaces/zitadel/base/deployment-api.yaml#L122-L148)
for the sidecar source.

**Recovery option — restore from a prior GSM secret version.**
GSM keeps every uploaded version unless explicitly destroyed. List
versions and look for a known-good one (created on or before the
last successful Pulumi run):

```bash
gcloud secrets versions list zitadel-admin-sa-key \
  --project=liverty-music-dev \
  --format='table(name,state,createTime)'
```

If a prior `STATE=ENABLED` version exists, fetch and verify it:

```bash
PRIOR=<version-number>
gcloud secrets versions access "$PRIOR" --secret=zitadel-admin-sa-key \
  --project=liverty-music-dev > /tmp/zitadel-admin-sa-key.json
# Run the sanity script from Step 2; if it succeeds, mark this version as
# the new "latest" by adding a new version that is a copy of the prior:
gcloud secrets versions access "$PRIOR" --secret=zitadel-admin-sa-key \
  --project=liverty-music-dev \
  | gcloud secrets versions add zitadel-admin-sa-key \
    --project=liverty-music-dev --data-file=-
```

Then retry [Step 2](#step-2--confirm-the-sa-key-authenticates-against-zitadel).

**No prior version available.** Scenario A collapses into Scenario B
— without any working SA key for the existing `pulumi-admin` user,
there is no path to recover that user's identity short of
re-bootstrapping the whole instance with a fresh `pulumi-admin` (and
fresh SA key).

### B. `pulumi-admin` user deleted from Zitadel (no SA key valid)

This is a **total lockout** state — there is no IAM_OWNER identity
that can authenticate. Recovery requires re-bootstrapping Zitadel
with a fresh first-instance run, which regenerates `pulumi-admin` and
its key:

1. **Verify the lockout** — confirm both human and machine paths fail
   (Console returns 401 / Pulumi preview returns "permission denied").
2. **Verify there are no human end users to lose** —
   `POST /v2/users/_search` filtered by `type=HUMAN` should return only
   the locked-out admins. Self-hosted dev should have zero end users
   (they live in `liverty-music` product org and only post-launch).
3. **DROP and recreate the `zitadel` database in Cloud SQL.** The IAM
   user `zitadel@liverty-music-dev.iam` cannot do this — it has the
   `cloudsqliamuser` role only and (a) defaults to connecting to the
   `zitadel` database (so PostgreSQL refuses `DROP DATABASE zitadel`
   with "cannot drop the currently open database"), and (b) lacks
   `CREATEDB` and ownership of the existing DB. Authenticate as the
   built-in `postgres` superuser instead — same approach as
   [`k8s/namespaces/zitadel/base/job-grant-db.yaml`](../../k8s/namespaces/zitadel/base/job-grant-db.yaml).

   Start a Cloud SQL Auth Proxy *without* `--auto-iam-authn` and a
   psql client pod, both pointed at the `postgres` database (not
   `zitadel`):

   ```bash
   # Fetch the postgres admin password from GSM. The secret name
   # matches the ESC-managed `gcp.postgresAdminPassword` value.
   PG_ADMIN_PASSWORD=$(gcloud secrets versions access latest \
     --project=liverty-music-dev --secret=postgres-admin-password)

   # In one terminal: port-forward Cloud SQL Auth Proxy to localhost.
   kubectl -n zitadel run sql-proxy-rescue \
     --rm -i --restart=Never --image=gcr.io/cloud-sql-connectors/cloud-sql-proxy:2 \
     --command -- \
     --psc --port=5432 --address=0.0.0.0 \
     liverty-music-dev:asia-northeast2:postgres-osaka &

   kubectl -n zitadel port-forward pod/sql-proxy-rescue 5432:5432 &

   # In another terminal: connect to the `postgres` DB (not zitadel).
   PGPASSWORD="$PG_ADMIN_PASSWORD" psql \
     -h 127.0.0.1 -p 5432 -U postgres -d postgres \
     -v ON_ERROR_STOP=1 <<'SQL'
   DROP DATABASE zitadel;
   CREATE DATABASE zitadel;
   SQL
   ```

   The new database is owned by `cloudsqlsuperuser`. ArgoCD's
   `zitadel-db-grant` Job (also in `k8s/namespaces/zitadel/base/`)
   will re-grant ownership to `zitadel@liverty-music-dev.iam` on its
   next sync — no manual GRANT step needed here.

4. **Restart the Zitadel deployment** so `start-from-init` runs against
   the empty DB:
   ```bash
   kubectl -n zitadel rollout restart deployment/zitadel
   ```
5. **Wait for `bootstrap-uploader: upload complete`** in the new pod's
   logs. This *is* a true first-instance boot now, so the sidecar
   fires correctly and the new admin SA key lands in GSM. The new
   admin org is named `admin` because
   `ZITADEL_FIRSTINSTANCE_ORG_NAME=admin` is in the ConfigMap.
6. **Update `constants.ts.ZITADEL_DEV_ADMIN_ORG_ID`** with the new org
   id (search via `POST /admin/v1/orgs/_search`).
7. **`pulumi up`** to re-provision `liverty-music` product org, IdPs,
   human admin, link, etc. (Per the project CLAUDE.md, dev `pulumi
   up` runs via Pulumi Cloud Deployments on PR merge — open a PR with
   the constants update and let the auto-deploy run.)
8. Follow [`add-zitadel-admin-user.md`](add-zitadel-admin-user.md) to
   re-link each human admin's Google identity (the user IDs change
   with the new instance, so existing ESC sub records still apply but
   need new `userId` lookups).

This is a destructive procedure (loses any Pulumi-managed
`MachineKey` rotations, custom Action revisions, etc.). Reach for it
only after confirming option A is genuinely impossible.

### C. Cloud SQL eventstore corrupt

Out of scope for this runbook — recovery is via Cloud SQL PITR
(Point-In-Time-Recovery) to a known-good timestamp before the
corruption, then re-running the steps above against the restored DB.
See the Cloud SQL operational runbook (separate doc).

## After recovery — drift sweep

A break-glass intervention often leaves Pulumi state out of sync with
reality (the admin-side fix is usually a hand-API-call, not a
declarative change). Reconcile:

```bash
cd ~/dev/src/github.com/liverty-music/cloud-provisioning
pulumi -s dev refresh --yes
pulumi -s dev preview
# expected: empty diff. Anything non-empty is drift introduced by the
# manual fix and should be either codified into the next PR or reverted.
```

## Reference

- OpenSpec change: `add-zitadel-console-admin-via-google-idp`
- Spec requirement: *"Retain Break-glass Machine User"*
- Pulumi provider wiring: [`src/zitadel/index.ts`](../../src/zitadel/index.ts) (`jwtProfileJson`)
- Bootstrap-uploader sidecar: [`k8s/namespaces/zitadel/base/deployment-api.yaml`](../../k8s/namespaces/zitadel/base/deployment-api.yaml)
- Admin user lifecycle (everyday path): [`add-zitadel-admin-user.md`](add-zitadel-admin-user.md)
- Zitadel hang incident: [`zitadel-hang.md`](zitadel-hang.md)
