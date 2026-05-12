# Runbook: set up prod credentials before first `pulumi up --stack prod`

> **Background:** The `liverty-music-prod` GCP project is empty by
> default. Before the operator can run the first `pulumi up --stack
> prod`, a handful of secrets must exist in the
> `liverty-music/prod` Pulumi ESC environment so that
> `requireSecretObject` / `requireObject` calls in
> [`src/index.ts`](../../src/index.ts) succeed and conditional secret
> resources (Cloud SQL admin password, blockchain keys, VAPID) get
> provisioned correctly. This runbook is the prod-specific
> companion to
> [`docs/TICKET_SYSTEM_SETUP.md`](../TICKET_SYSTEM_SETUP.md), which
> documents the underlying procedures for the dev environment
> (Base Sepolia, dev-only Foundry workflow, dev VAPID keys).
>
> **Out of scope:** This runbook does not cover ZKP circuit build
> (Part B of `TICKET_SYSTEM_SETUP.md`); circuit artifacts are env-
> agnostic and the same files are baked into the container images
> regardless of environment.

## When to use this runbook

Run this once per new prod environment activation, prior to the
first `pulumi up --stack prod`. It is also the reference for
**rotating** any of the listed secrets in prod (each section's
"Rotation" subsection covers that).

## Prerequisites

- [Pulumi ESC CLI](https://www.pulumi.com/docs/esc/) authenticated
  against the `liverty-music` org (`esc env ls` should list
  `liverty-music/prod`).
- [Foundry](https://book.getfoundry.sh/) installed locally
  (`cast --version` returns 0.x.x). Install with:
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```
- [Alchemy](https://dashboard.alchemy.com/) account with permission
  to create a new app under the `liverty-music` workspace (or use a
  fresh personal account if no workspace exists yet).
- A password manager / secrets vault for offline storage of
  generated values (1Password, Bitwarden, hardware key recovery
  seed, etc.).
- Permission to write secrets to the `liverty-music/prod` ESC
  environment (the `pannpers` org owner role suffices today).

## Inventory

The following keys must exist in `liverty-music/prod`
`pulumiConfig` before the first prod `pulumi up`:

| Key | Required? | Mode | Generation |
|---|---|---|---|
| `zitadel.googleAdminIdp.clientId` | ✅ (compile-time gate) | plaintext | Placeholder OK — never read in prod |
| `zitadel.googleAdminIdp.clientSecret` | ✅ (compile-time gate) | `--secret` | Placeholder OK — never read in prod |
| `zitadel.adminGoogleSubs.pannpers` | ✅ (compile-time gate) | `--secret` | Reuse dev value (same Google sub) |
| `gcp.postgresAdminPassword` | ⚠️ Recommended | `--secret` | Random 32-char alphanumeric (this runbook §4) |
| `blockchain.deployerPrivateKey` | ⚠️ When ticket workload deploys | `--secret` | `cast wallet new` against Base **mainnet** (this runbook §1) |
| `blockchain.rpcUrl` | ⚠️ When ticket workload deploys | `--secret` | Alchemy Base **mainnet** app (this runbook §2) |
| `blockchain.bundlerApiKey` | ⚠️ When ticket workload deploys | `--secret` | Same Alchemy app as §2 (this runbook §3) |
| `gcp.vapidPrivateKey` | ⚠️ When backend push notifications deploy | `--secret` | New VAPID keypair (this runbook §5) |

`✅ Required` keys block `pulumi up --stack prod` at module load
because [`src/index.ts:44-47`](../../src/index.ts#L44-L47) calls
`requireSecretObject('zitadel')` eagerly. The `⚠️` keys are only
read inside conditional `...(value ? [...] : [])` expressions, so
the prod stack will provision without them — the corresponding
GCP Secret Manager secret simply will not exist until the value is
set and a follow-up `pulumi up` is run.

## Already configured

These three keys have already been set in `liverty-music/prod` as
part of the
[`provision-prod-gcp-resources`](https://github.com/liverty-music/specification/pull/445)
change. They are listed here only for context — re-running the
`set` commands is not required unless you are rebuilding the
environment from scratch. **Values are intentionally not in this
runbook; retrieve them at execution time from authoritative
sources (the live ESC environments)** so this doc never carries
a live secret in plain text.

If you do need to re-establish them (e.g., recovering a wiped
ESC environment), follow this procedure rather than copying
values from anywhere else:

```bash
# 1. adminGoogleSubs.pannpers — the human operator's Google `sub`
# claim. Public-ish (anyone the user has authenticated against
# via Google OAuth has seen it) but ESC stores it as a secret.
# Reuse the same value as dev because it identifies the same
# human, not the application.
SUB=$(esc open liverty-music/dev pulumiConfig.zitadel.adminGoogleSubs.pannpers --format string)
esc env set liverty-music/prod pulumiConfig.zitadel.adminGoogleSubs.pannpers \
  "$SUB" --secret
unset SUB

# 2. googleAdminIdp.clientId / clientSecret — placeholders, never
# read in prod (src/index.ts:73 env-gate). They exist only to
# satisfy `requireSecretObject('zitadel')`. Generate fresh values
# with the same length/shape as a real Google OAuth Web Client:
CLIENT_ID="$(gcloud projects describe liverty-music-prod --format='value(projectNumber)')-$(openssl rand -hex 16).apps.googleusercontent.com"
esc env set liverty-music/prod pulumiConfig.zitadel.googleAdminIdp.clientId \
  "$CLIENT_ID"
unset CLIENT_ID

CLIENT_SECRET="GOCSPX-$(openssl rand -base64 21)"
esc env set liverty-music/prod pulumiConfig.zitadel.googleAdminIdp.clientSecret \
  "$CLIENT_SECRET" --secret
unset CLIENT_SECRET
```

**When prod Zitadel actually goes live** (out of scope for this
runbook), replace the `googleAdminIdp` placeholders with the real
Google OAuth Web Application client created in the GCP Console
under the `liverty-music-prod` project, and remove the env-gate
in `src/index.ts:73` so the values are actually consumed.

---

## §1 — `blockchain.deployerPrivateKey` (Base mainnet EOA)

The deployer EOA signs `mintTicket` transactions for the
`TicketSBT` contract on Base **mainnet** (chain ID `8453`). It
must be funded with real ETH to pay gas, so the security posture
is much stricter than dev's Base Sepolia EOA.

### Procedure

1. **Generate a fresh EOA dedicated to prod.** Do not reuse the
   dev key under any circumstances — the dev key has been written
   to local files during early development (see `backend/tmp/`)
   and is unsuitable for production.

   ```bash
   cast wallet new
   ```

   Output:
   ```
   Successfully created new keypair.
   Address:     0x...
   Private key: 0x... (64 hex chars)
   ```

2. **Store the private key offline immediately.** Recommended
   storage:
   - 1Password / Bitwarden vault entry titled "Liverty Music prod
     deployer EOA — DO NOT SHARE".
   - Hardware wallet recovery seed (preferred for long-term).

   **Do not** write the private key to a file in any git-tracked
   directory, even under `tmp/`. Do not paste it into chat
   transcripts. Do not echo it to `stdout` in shared terminals.

3. **Record the address in the Public Values Registry** at the
   bottom of this runbook (§6). The address itself is not
   sensitive — it appears on every transaction the EOA signs —
   but having it documented prevents losing track of *which*
   EOA holds `MINTER_ROLE` after the TicketSBT contract is
   deployed. See §6 for the exact slot to fill in.

4. **Fund the address with Base mainnet ETH.** Approximate cost:
   - SBT contract deploy: ~$2-5 USD worth of ETH at typical
     mainnet gas prices.
   - Initial buffer: keep 0.01-0.02 ETH (~$30-60 USD) to cover
     the deploy plus the first month of `mintTicket` calls.

   Bridge from a centralized exchange or use the
   [Base bridge](https://bridge.base.org/) from mainnet Ethereum.

5. **Verify the balance** before writing the secret:

   ```bash
   cast balance <ADDRESS> --rpc-url https://mainnet.base.org
   ```

   Output is in wei. Convert with
   `cast --from-wei <wei>` or `cast call ... | cast --from-wei`.

6. **Register in ESC** using a tty-only read (no shell history):

   > ⚠️ **Paste the PRIVATE KEY, not the address.**
   > `cast wallet new` outputs both an `Address:` line and a
   > `Private key:` line. The two are easy to confuse because both
   > start with `0x`, but:
   > - The **address** is **42 chars** total (`0x` + 40 hex).
   > - The **private key** is **66 chars** total (`0x` + 64 hex).
   >
   > A 42-char value pasted here will fail `cast wallet address
   > --private-key …` with "Failed to decode private key". The
   > runbook §6.1 includes a history note about this exact
   > confusion happening on 2026-05-12. Length-check before
   > running the `esc env set` below.

   ```bash
   read -s PROD_DEPLOYER_KEY  # paste 0x...{64 hex} — input is invisible
   echo  # add newline after the silent read

   # Length check before storing — must be 66 (= 0x + 64 hex).
   # If it prints anything other than 66, you pasted the wrong value.
   echo "Length check: ${#PROD_DEPLOYER_KEY} (expected: 66)"

   esc env set liverty-music/prod pulumiConfig.blockchain.deployerPrivateKey \
     "$PROD_DEPLOYER_KEY" --secret
   unset PROD_DEPLOYER_KEY
   ```

### Verification

```bash
esc env get liverty-music/prod pulumiConfig.blockchain.deployerPrivateKey
# expected: [secret]
```

**Optional but recommended** — derive the public address from the
stored value and confirm it matches the §6.1 record. This catches
the "pasted address instead of private key" failure mode (see
§6.1 history note) before any prod deploy. Save the snippet below
as a small script so the private key never lands in shell history:

```bash
cat > /tmp/verify-prod-deployer.sh <<'EOF'
#!/bin/bash
set -euo pipefail
PRIV=$(esc env open liverty-music/prod pulumiConfig.blockchain.deployerPrivateKey --format string)
echo "Length: ${#PRIV} (expected: 66 = 0x + 64 hex)"
ADDR=$(cast wallet address --private-key "$PRIV")
echo "Derived address: $ADDR"
echo "Expected (from §6.1): cross-check against runbook"
unset PRIV ADDR
EOF
chmod +x /tmp/verify-prod-deployer.sh
/tmp/verify-prod-deployer.sh
rm /tmp/verify-prod-deployer.sh
```

If "Length" is 42 (not 66), the ESC value is the address, not
the private key — locate the actual private key in offline
storage and re-run §1 step 6 to overwrite the ESC value.

### Rotation

To rotate, generate a fresh EOA via `cast wallet new`, fund it,
grant it `MINTER_ROLE` on the deployed `TicketSBT` contract
(grant via the previous deployer, see `backend/contracts/README.md`
for the role grant procedure), revoke `MINTER_ROLE` from the old
EOA, then re-run §1 step 6 to update the ESC secret.

---

## §2 — `blockchain.rpcUrl` (Base mainnet JSON-RPC)

This is the JSON-RPC HTTPS endpoint the backend uses to read
on-chain state and submit transactions. Procedure mirrors
[`TICKET_SYSTEM_SETUP.md` Step 3-b](../TICKET_SYSTEM_SETUP.md#3-b-create-an-app-and-get-the-rpc-url)
with two prod-specific deltas: a separate Alchemy app, and the
mainnet endpoint format.

### Procedure

> **Note on Alchemy's app model:** A single Alchemy app can have
> multiple networks enabled simultaneously (e.g., Base Sepolia
> *and* Base Mainnet, sharing one API key per app). Technically
> this means you *could* enable Base Mainnet on the existing dev
> app and reuse its key for prod. **Do not do this.** A shared
> key collapses the blast radius — a leaked dev key (CI log, local
> `.env`, shoulder-surf) would also grant attackers mainnet RPC
> access. Always provision a dedicated prod app, even though it
> is not technically required.

1. **Create a new Alchemy app**, distinct from any dev app.
   - Sign in at [dashboard.alchemy.com](https://dashboard.alchemy.com/).
   - "Create new app".
   - Name: `Liverty Music — prod` (or similar — the app can have
     multiple networks; the name should identify the env, not the
     chain).
   - Initial network: enable **Base Mainnet**.
   - Leave **Base Sepolia disabled** on the prod app. The prod
     workload must not have a path to testnet, even accidentally.

2. **Copy the HTTPS endpoint** for Base Mainnet from the new app's
   dashboard ("Node RPC Setup" tab → "Endpoint URL" section).
   Format:

   ```
   https://base-mainnet.g.alchemy.com/v2/<YOUR_API_KEY>
   ```

   The `<YOUR_API_KEY>` segment is **specific to this prod app**
   and must differ from the dev app's key. Confirm before
   proceeding by comparing the API key shown at the top of the
   prod app's dashboard against the dev key in `liverty-music/dev`
   ESC (`esc env open liverty-music/dev pulumiConfig.blockchain.rpcUrl --format string`).
   If they match, you accidentally enabled mainnet on the dev app
   — stop, disable mainnet on dev, and create a fresh prod app
   from step 1.

3. **Register in ESC**:

   ```bash
   read PROD_RPC_URL  # paste the full HTTPS URL
   esc env set liverty-music/prod pulumiConfig.blockchain.rpcUrl \
     "$PROD_RPC_URL" --secret
   unset PROD_RPC_URL
   ```

   `read` (not `read -s`) is fine here — the URL is sensitive
   (contains an API key) but seeing it briefly while pasting is
   acceptable.

### Verification

```bash
esc env get liverty-music/prod pulumiConfig.blockchain.rpcUrl
# expected: [secret]
```

You can also dial the endpoint directly with a benign
`eth_chainId` call to confirm it works and is on mainnet:

```bash
curl -sS -X POST <RPC_URL> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# expected: {"jsonrpc":"2.0","result":"0x2105","id":1}  (0x2105 = 8453 = Base mainnet)
```

### Plan & cost considerations

- Alchemy free tier (300M compute units/month) covers MVP
  traffic. Upgrade to **Growth** ($49/month) only if rate-
  limited or compute-unit-capped during real prod traffic.
- An alternative provider (QuickNode, Tenderly, Infura) works
  equivalently — only the URL format changes. Stick with
  Alchemy for now because the AA bundler (§3) is in the same
  app.

### Rotation

Click "Reset API key" on the Alchemy dashboard, copy the new
endpoint, re-run §2 step 3. The old key keeps working until
manually revoked, so transactions in flight will not fail mid-
rotation.

---

## §3 — `blockchain.bundlerApiKey` (ERC-4337 / Account Abstraction)

The bundler key sponsors gas for end-user `mintTicket` calls via
the ERC-4337 EntryPoint. With Alchemy, the bundler API key is
**the same value** as the API key embedded in the RPC URL — they
share one app. With Pimlico (alternative), the bundler key is
separate.

### Procedure (Alchemy, recommended)

1. In the same prod app from §2, enable **Account Kit → Gas
   Manager**.
2. Create a **Sponsorship Policy** with conservative limits:
   - Allowed methods: `mintTicket`, `transferFrom`, `setApprovalForAll`
     (or whatever the live `TicketSBT` ABI exposes).
   - Per-user monthly limit: e.g. 10 transactions × ~$0.05 gas
     each = $0.50 / user / month.
   - Total monthly budget: e.g. $50 (1000 sponsored mints / month).
   - Adjust upward only after observing real traffic.
3. The bundler API key equals the trailing path segment of the
   RPC URL from §2. Extract it programmatically rather than re-
   pasting:

   ```bash
   PROD_RPC_URL=$(esc open liverty-music/prod pulumiConfig.blockchain.rpcUrl --format string)
   PROD_BUNDLER_KEY="${PROD_RPC_URL##*/v2/}"
   esc env set liverty-music/prod pulumiConfig.blockchain.bundlerApiKey \
     "$PROD_BUNDLER_KEY" --secret
   unset PROD_BUNDLER_KEY PROD_RPC_URL
   ```

### Procedure (Pimlico, alternative)

1. Sign up at [dashboard.pimlico.io](https://dashboard.pimlico.io/).
2. Create an API key scoped to **Base mainnet**.
3. The bundler URL is
   `https://api.pimlico.io/v2/base/rpc?apikey=<KEY>`.
4. Use only the `<KEY>` portion as the secret value:

   ```bash
   read -s PROD_BUNDLER_KEY
   echo
   esc env set liverty-music/prod pulumiConfig.blockchain.bundlerApiKey \
     "$PROD_BUNDLER_KEY" --secret
   unset PROD_BUNDLER_KEY
   ```

### Verification

```bash
esc env get liverty-music/prod pulumiConfig.blockchain.bundlerApiKey
# expected: [secret]
```

### ⚠️ Gas-sponsorship safety

Without per-user / per-policy limits, a single malicious actor
can drain the Gas Manager budget. Always set explicit limits
before enabling the policy. Monitor the Alchemy dashboard daily
for the first month after prod launch.

### Rotation

If Alchemy: rotating the §2 RPC key also rotates the bundler
key (same app). Re-run both §2 step 3 and §3's extraction
command after the reset.

If Pimlico: rotate the dedicated Pimlico key independently.

---

## §4 — `gcp.postgresAdminPassword` (Cloud SQL `postgres` superuser)

The Cloud SQL `postgres` admin role is used by Atlas migrations
and as emergency break-glass DB access. Day-to-day workloads use
IAM auth (see [DEV_VS_PROD_DIFFERENCES.md](../DEV_VS_PROD_DIFFERENCES.md)),
but Atlas needs the password-authenticated admin to run schema
migrations.

This procedure is not documented in `TICKET_SYSTEM_SETUP.md` —
treat this section as the canonical reference for any future
env's `postgresAdminPassword` setup.

### Procedure

1. **Generate a strong random password** locally:

   ```bash
   openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32
   ```

   The output is 32 characters of mixed-case alphanumeric. This
   command does not require any external service.

2. **Save the password in a vault** (1Password / Bitwarden /
   hardware key). The Cloud SQL instance can be re-provisioned
   if the password is lost — but at the cost of either an Atlas
   migration restart or a manual `gcloud sql users set-password
   postgres ...` against the live instance using IAM auth as a
   superuser.

3. **Register in ESC** without printing the password to the
   terminal:

   ```bash
   PROD_DB_PW=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)
   # Show ONCE for vault storage
   echo "Save this to your vault NOW (press Enter when done):"
   echo "$PROD_DB_PW"
   read
   # Clear the screen so the password does not linger
   clear
   esc env set liverty-music/prod pulumiConfig.gcp.postgresAdminPassword \
     "$PROD_DB_PW" --secret
   unset PROD_DB_PW
   ```

### Verification

```bash
esc env get liverty-music/prod pulumiConfig.gcp.postgresAdminPassword
# expected: [secret]
```

To verify the password actually works post-`pulumi up`, dial
the Cloud SQL Auth Proxy with this credential:

```bash
# In a separate shell, with cloud-sql-proxy running:
cloud-sql-proxy liverty-music-prod:asia-northeast2:postgres-osaka &
psql -h 127.0.0.1 -U postgres -d postgres
# password: <paste from vault>
```

Exit with `\q`. Do not stay logged in as superuser longer than
needed for verification.

### Rotation

To rotate without breaking Atlas migrations:

1. Generate a new password (§4 step 1).
2. Update the Cloud SQL `postgres` user's password via IAM-
   authed superuser session:
   ```sql
   ALTER USER postgres WITH PASSWORD '<new>';
   ```
3. Update the ESC value (§4 step 3).
4. Re-run `pulumi up --stack prod` to refresh any downstream
   ExternalSecret references (Atlas typically picks up the new
   value via ESO sync on the next migration run).

---

## §5 — `gcp.vapidPrivateKey` (Web Push notifications)

The VAPID private key signs Web Push subscriptions. Procedure
is identical to dev's: follow
[`TICKET_SYSTEM_SETUP.md` Part C, Step 12](../TICKET_SYSTEM_SETUP.md#step-12--generate-vapid-key-pair)
to generate a new keypair (do **not** reuse the dev keypair —
browsers identify the sender by VAPID public key, and reusing
dev's would let dev subscriptions accept push messages signed by
prod).

### Procedure

Generate a fresh keypair:

```bash
npx web-push generate-vapid-keys
```

Then register the private key in prod ESC:

```bash
read -s PROD_VAPID_PRIVATE
echo
esc env set liverty-music/prod pulumiConfig.gcp.vapidPrivateKey \
  "$PROD_VAPID_PRIVATE" --secret
unset PROD_VAPID_PRIVATE
```

**Record the public key in the Public Values Registry (§6)
immediately**, even though it has no live consumer in prod yet
— the prod backend k8s overlay (the follow-up `k8s-manifests`
PR) will need it as `VAPID_PUBLIC_KEY` in a ConfigMap, and the
generated keypair only outputs the public key once. Losing
it forces regenerating both keys and silently invalidating
any future subscriptions.

### Rotation

Generate a new keypair, register the new private key in ESC,
update the prod backend ConfigMap with the new public key, and
restart the backend deployment. **Existing user subscriptions
issued with the old public key will silently fail to receive
notifications until users re-subscribe.** Coordinate rotation
with frontend deploy so re-subscription is handled gracefully.

---

## §6 — Public Values Registry

Setting the secrets in §1-§5 generates a handful of **public**
counterparts that are not stored in ESC (because they are not
sensitive) but must still be registered somewhere durable so
that downstream steps — contract deploy, ConfigMap authoring,
operator audit — can find them. This table is that registry.

> **Update this section in the same PR** that activates the
> corresponding secret. If the slot says `<fill in>`, the
> operator who ran the §N procedure is responsible for replacing
> it with the real value before submitting the runbook update.

### 6.1 Prod deployer EOA address (from §1)

The Ethereum address corresponding to the prod
`blockchain.deployerPrivateKey`. Used to:

- Grant `MINTER_ROLE` on the deployed `TicketSBT` contract
  (see `backend/contracts/README.md`).
- Verify on-chain that mint transactions came from us
  (block explorer audit).
- Sanity-check during rotation (the new EOA's address must be
  granted the role before the old one is revoked).

```
Prod deployer EOA: 0x7FE70338c552485aa632224b218b507F4BFcf483
Generated on:      2026-05-12 (via `cast wallet new`, regeneration)
Funded with:       <fill in: e.g., 0.02 ETH from CEX bridge at YYYY-MM-DD>
```

> **History note (2026-05-12 incident):** The prod deployer EOA
> was registered twice on the same day.
>
> 1. **First attempt** (abandoned): generated via `cast wallet
>    new`, address `0x494194a3edE99CdF881f4dAC777Aef226b38A498`.
>    During §1 step 6 ESC registration, the *address* (42 chars)
>    was mistakenly pasted into
>    `pulumiConfig.blockchain.deployerPrivateKey` in place of
>    the actual 66-char private key. The operator had not
>    archived the private key offline, so it could not be
>    recovered. The address `0x4941...A498` is therefore
>    orphaned — if any mainnet ETH was sent to it before the
>    mistake was caught, those funds are unrecoverable.
> 2. **Second attempt** (current): regenerated via
>    `/tmp/regen-prod-deployer-eoa.sh` which captured the
>    private key into ESC directly without exposing it. New
>    address: `0x7FE70338c552485aa632224b218b507F4BFcf483`.
>    `cast wallet address --private-key <esc-value>` returns
>    this address, confirming the keypair is intact.
>
> Lessons baked into §1 to prevent recurrence:
> - §1 step 6 now requires a **length check** (must be 66) before
>   `esc env set` — see the inline warning in §1 step 6.
> - §1 Verification now includes a `cast wallet address`
>   derivation snippet so the operator can self-check the
>   stored value at any time.
> - §6 (this section) is the durable record of the address,
>   eliminating the "I lost track of the address" failure mode
>   that triggered this incident.

### 6.2 Prod TicketSBT contract address (from `backend/contracts/`)

The Soulbound Token contract address on Base mainnet after the
deploy script runs against the prod EOA. This is **not** generated
by this runbook — it is generated by `forge script` in
`backend/contracts/` — but it is recorded here because:

- The prod backend k8s ConfigMap will read it as
  `TICKET_SBT_ADDRESS` (see existing dev pattern in commit
  [`c6a5ae4`](https://github.com/liverty-music/cloud-provisioning/commit/c6a5ae4)).
- The frontend may need it for client-side mint calls.
- Block explorer verification needs it.

```
Prod TicketSBT contract: <fill in after deploy: 0x... — 42 chars>
Deployed at block:       <fill in: block number for audit anchor>
Deployer (must match 6.1): <copy from 6.1>
MINTER_ROLE granted to:    <copy from 6.1>
Deploy script tx hash:     <fill in: 0x... — 66 chars>
Deploy date:               <fill in: YYYY-MM-DD>
```

After deploy, register this value in the prod backend ConfigMap
(scope of the follow-up `k8s-manifests-prod` PR). Until that
PR lands, the contract address has no live consumer — but
recording it here prevents losing it.

### 6.3 Prod VAPID public key (from §5)

The browser-side counterpart of `gcp.vapidPrivateKey`. Browsers
include this in `pushManager.subscribe()` to identify the sender,
and the backend signs push payloads with the matching private
key. Every existing user's subscription is bound to this exact
public key — rotating it silently invalidates all subscriptions.

```
Prod VAPID public key: BH-m9-6-0-y70MdQG7Lz-htDaz4T_NuYdmcgK5wBEElzXo22AyGs30gvHAtHbWtQBQa4XxySD6ZEaiM9Crwl6Pc
Generated on:          2026-05-12 (via `npx web-push generate-vapid-keys`)
```

The prod backend k8s ConfigMap (follow-up `k8s-manifests-prod`
PR) consumes this as `VAPID_PUBLIC_KEY`. The frontend reads it
from `/api/web-push/public-key` at runtime (which proxies the
backend env var) — frontend has no direct ConfigMap entry.

### 6.4 Alchemy app metadata (from §2)

For ops traceability (no functional consumer). Optional but
useful when investigating rate-limit incidents or rotation.

```
Alchemy prod app name: <fill in: e.g., "Liverty Music — prod">
Alchemy app team:      <fill in: which Alchemy team/account owns it>
Created on:            <fill in: YYYY-MM-DD>
Dashboard URL:         https://dashboard.alchemy.com/apps/<app-id>
```

### Why this registry lives in the runbook

Splitting public-value bookkeeping into a separate file would
desync the registry from the procedure that generates the
values. By embedding it in §6, the operator running §1-§5 is
prompted (via the cross-references in those sections) to come
back to §6 and fill it in. Future operators can read top-to-
bottom and know exactly what was generated when.

---

## Final verification

Once all keys are set:

```bash
esc env get liverty-music/prod
```

Every `pulumiConfig.*` key listed in the "Inventory" table at the
top of this runbook should appear (secrets shown as `[secret]`).

Then run a config-only Pulumi preview to confirm there are no
missing-key errors before any infrastructure is touched:

```bash
cd ~/dev/src/github.com/liverty-music/cloud-provisioning
pulumi stack select prod
pulumi preview --stack prod --diff
```

If `requireSecretObject` or `requireObject` complains about a
missing key, set that key per the appropriate section above and
re-run the preview.

## Safety checklist (one-time, before first prod deploy)

- [ ] All `✅ Required` keys exist in `liverty-music/prod` ESC.
- [ ] Prod deployer EOA address recorded in §6.1.
- [ ] Prod deployer EOA holds ≥ 0.01 ETH on Base mainnet.
- [ ] Alchemy Gas Manager policy has explicit per-user and
  total monthly budget limits.
- [ ] Alchemy prod app metadata recorded in §6.4 (at least
  app name + team).
- [ ] Postgres admin password is in a vault you can recover
  in 6 months.
- [ ] VAPID public key recorded in §6.3 (the only place it
  exists outside the original `web-push generate-vapid-keys`
  terminal output).
- [ ] No private keys are in any git-tracked file (`git grep
  -i 'private.*key'` returns only docs and ABI-related code).
- [ ] No private keys appear in shell history (`history | grep
  -iE 'private|secret|0x[0-9a-f]{64}'` returns nothing).

## Checklist (after `TicketSBT` contract deploy)

- [ ] `TicketSBT` deployed against prod EOA per
  `backend/contracts/README.md`.
- [ ] Contract address + tx hash + block number recorded in
  §6.2.
- [ ] `MINTER_ROLE` granted to the deployer EOA on the live
  contract; verified on basescan.org.
- [ ] Contract address propagated to the prod backend ConfigMap
  (`TICKET_SBT_ADDRESS`) in the follow-up `k8s-manifests-prod`
  PR.

## See also

- [`docs/TICKET_SYSTEM_SETUP.md`](../TICKET_SYSTEM_SETUP.md) —
  full dev setup procedure (Base Sepolia, ZKP circuit build,
  dev VAPID).
- [`docs/PROD_BOOTSTRAP_DECISIONS.md`](../PROD_BOOTSTRAP_DECISIONS.md) —
  decision log for the prod cluster (irreversibility, mode
  choice, CMEK).
- [`docs/DEV_VS_PROD_DIFFERENCES.md`](../DEV_VS_PROD_DIFFERENCES.md) —
  operator-facing diff table.
- [`docs/runbooks/prod-cluster-credentials.md`](./prod-cluster-credentials.md) —
  kubectl auth and live-cluster verification.
- OpenSpec change `provision-prod-gcp-resources` in
  [liverty-music/specification](https://github.com/liverty-music/specification) —
  the change that established the prod cluster.
