# Ticket System — Setup Guide

This guide walks through generating and registering the secrets and artifacts required by the ticket system.

## Table of Contents

- [Overview](#overview)
- [Part A: Blockchain Secrets (Steps 1–6)](#part-a-blockchain-secrets)
- [Part B: ZKP Circuit Build (Steps 7–11)](#part-b-zkp-circuit-build)
- [Part C: VAPID Key Generation (Steps 12–14)](#part-c-vapid-key-generation)
- [Troubleshooting](#troubleshooting)

---

## Overview

The ticket system requires three categories of configuration:

### A. Blockchain Secrets (Ticket Minting)

| Secret name               | Purpose                                                                      |
|---------------------------|------------------------------------------------------------------------------|
| `blockchain-deployer-private-key` | Private key of the EOA that deploys and mints TicketSBT NFTs on Base Sepolia |
| `blockchain-rpc-url`    | JSON-RPC endpoint for the Base Sepolia testnet                               |
| `bundler-api-key`         | ERC-4337 bundler API key (Pimlico or Alchemy Account Kit)                   |

### B. ZKP Circuit Artifacts (Entry Verification)

| Artifact                 | Purpose                                                              |
|--------------------------|----------------------------------------------------------------------|
| `verification_key.json`  | Server-side Groth16 verification key (used by backend)               |
| `ticketcheck.wasm`       | Client-side witness calculator (used by frontend / snarkjs)          |
| `ticketcheck_final.zkey` | Client-side proving key (used by frontend / snarkjs)                 |

### C. VAPID Keys (Web Push Notifications)

| Secret name        | Purpose                                                    |
|--------------------|------------------------------------------------------------|
| `vapid-private-key`| ECDSA P-256 private key for signing push notification requests |
| `VAPID_PUBLIC_KEY` | Public key sent to browsers to subscribe to push notifications |

The `TicketSBT` Solidity contract (build, test, deploy) is managed in the `backend` repository.
See [backend/contracts/README.md](https://github.com/liverty-music/backend/blob/main/contracts/README.md) for the full contract workflow.

---

# Part A: Blockchain Secrets

## Prerequisites

Install [Foundry](https://book.getfoundry.sh/) to generate an Ethereum keypair with `cast`:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Verify:

```bash
cast --version   # cast 0.x.x (...)
```

---

## Step 1 — Generate the Deployer EOA

The deployer EOA is the Ethereum account that signs `mintTicket` transactions on Base Sepolia.
It needs a small amount of ETH to pay gas fees.

```bash
cast wallet new
```

Example output:

```
Successfully created new keypair.
Address:     0xAbCd...1234
Private key: 0xdeadbeef...
```

**Save both the address and the private key.** You will need:
- The **address** in Step 2 (to receive testnet ETH)
- The **private key** in Step 4 (to set the Pulumi secret)

> Keep the private key in a password manager or secure vault.
> Never commit it to version control.

---

## Step 2 — Fund the Deployer Address with Base Sepolia ETH

The deployer account needs Base Sepolia ETH to pay for minting transactions.

| Faucet | URL | Notes |
|--------|-----|-------|
| Alchemy Base Sepolia Faucet | <https://www.alchemy.com/faucets/base-sepolia> | Requires Alchemy account; 0.1 ETH/day |
| Coinbase Developer Platform Faucet | <https://portal.cdp.coinbase.com/products/faucet> | Requires CDP account |
| Superchain Faucet | <https://app.optimism.io/faucet> | Multi-chain; supports Base Sepolia |

Verify the balance:

```bash
cast balance <YOUR_ADDRESS> --rpc-url https://sepolia.base.org
```

A balance of `0.05 ETH` or more is sufficient for development.

---

## Step 3 — Obtain Alchemy RPC URL and Bundler API Key

You need two values from Alchemy:
1. A **Base Sepolia RPC URL** (`blockchain-rpc-url`)
2. A **Bundler API key** for ERC-4337 (`bundler-api-key`)

### 3-a. Create an Alchemy account

Sign up at <https://dashboard.alchemy.com/> (free tier available).

### 3-b. Create an app and get the RPC URL

1. In the Alchemy dashboard, click **Create new app**
2. Select **Chain**: Base → **Network**: Base Sepolia
3. Open the app and copy the **HTTPS** endpoint, e.g.:
   ```
   https://base-sepolia.g.alchemy.com/v2/<YOUR_API_KEY>
   ```
   This is your `blockchain-rpc-url`.

### 3-c. Get the Bundler API key

**Option A — Alchemy Account Kit (recommended)**

1. In the Alchemy dashboard, navigate to **Account Kit**
2. Enable **Gas Manager** for the same app
3. The API key is the trailing path segment of the endpoint URL (`<YOUR_API_KEY>`).

**Option B — Pimlico**

1. Sign up at <https://dashboard.pimlico.io/>
2. Create an API key for **Base Sepolia**
3. The bundler URL is:
   ```
   https://api.pimlico.io/v2/base-sepolia/rpc?apikey=<YOUR_API_KEY>
   ```
   Use `<YOUR_API_KEY>` as the `bundler-api-key` secret value.

---

## Step 4 — Register Secrets in Pulumi ESC

Run from the `cloud-provisioning` directory with the correct stack selected:

```bash
# Select your target stack (e.g., dev)
pulumi stack select dev

# Set secrets (values are encrypted at rest by Pulumi)
pulumi config set --path gcp.ticketSbtDeployerKey --secret <PRIVATE_KEY_HEX>
pulumi config set --path gcp.baseSepoliaRpcUrl    --secret <RPC_URL>
pulumi config set --path gcp.bundlerApiKey        --secret <API_KEY>
```

Verify (values will appear as `[secret]`):

```bash
pulumi config
```

---

## Step 5 — Deploy Contract and Go Bindings

Build, test, and deploy `TicketSBT` from the `backend` repository.
See **[backend/contracts/README.md](https://github.com/liverty-music/backend/blob/main/contracts/README.md)** for the full workflow:

- Prerequisites (Foundry, abigen)
- `forge install` / `forge build` / `forge test`
- `go generate` for Go ABI bindings
- `forge script` deploy to Base Sepolia
- Grant `MINTER_ROLE` to the deployer address

---

## Step 6 — Preview and Deploy Infrastructure

```bash
pulumi preview
```

Review the planned changes — three new Secret Manager resources should appear:

```
+ gcp:secretmanager/secret:Secret                   blockchain-deployer-private-key         create
+ gcp:secretmanager/secretVersion:SecretVersion     blockchain-deployer-private-key-version create
+ gcp:secretmanager/secret:Secret                   blockchain-rpc-url            create
...
```

Once satisfied, apply:

```bash
pulumi up
```

> **Approval required**: Per project policy, `pulumi up` must only be run after reviewing
> the preview output. See [CLAUDE.md](../CLAUDE.md) for the full Pulumi Deployment Approval Protocol.

---

# Part B: ZKP Circuit Build

This section describes how to compile the `ticketcheck` Circom circuit from source and produce the artifacts required by the frontend (browser-side proof generation) and backend (server-side verification).

## Architecture Overview

```
ticketcheck.circom  (Circom 2.0 source)
        │
        ├──[circom compile]──→  ticketcheck.r1cs     (constraint system)
        │                    →  ticketcheck.wasm      (witness calculator)
        │                    →  ticketcheck.sym       (debug symbols)
        │
        ├──[Powers of Tau]───→  pot_final.ptau        (Phase 1 ceremony output)
        │
        ├──[snarkjs setup]───→  ticketcheck_0000.zkey (Phase 2 initial key)
        │                    →  ticketcheck_final.zkey (Phase 2 final key)
        │                    →  verification_key.json  (verification key)
        │
        └── Outputs used by:
            ├── Frontend: ticketcheck.wasm + ticketcheck_final.zkey
            └── Backend:  verification_key.json
```

## Prerequisites

### Install Circom 2

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone and build Circom
git clone https://github.com/iden3/circom.git
cd circom
cargo build --release
cargo install --path circom

# Verify
circom --version   # circom compiler 2.x.x
```

### Install snarkjs

```bash
npm install -g snarkjs

# Verify
snarkjs --version   # 0.7.x or later
```

### Install circomlib (circuit dependencies)

The circuit uses Poseidon hash from `circomlib`. Dependencies are managed via the circuit's `package.json`:

```bash
cd frontend/circuits/ticketcheck-v1
npm install
```

---

## Step 7 — Compile the Circuit

The circuit source is at `frontend/circuits/ticketcheck-v1/ticketcheck.circom`.

```bash
cd frontend/circuits/ticketcheck-v1

# Create build directory
mkdir -p build

# Compile circuit to R1CS + WASM + symbol table
circom ticketcheck.circom \
  --r1cs \
  --wasm \
  --sym \
  --output build \
  -l node_modules
```

This produces:
- `build/ticketcheck.r1cs` — constraint system (~2.5 MB)
- `build/ticketcheck_js/ticketcheck.wasm` — witness calculator (~2.0 MB)
- `build/ticketcheck.sym` — debug symbols

**Verify the constraint count:**

```bash
snarkjs r1cs info build/ticketcheck.r1cs
```

Expected output: the number of constraints (varies by Merkle depth; depth=20 produces ~20k constraints).

---

## Step 8 — Download Powers of Tau (Phase 1)

The Groth16 setup requires a Powers of Tau ceremony output. For development, use the Hermez community ceremony files hosted by iden3.

Choose a `.ptau` file that supports at least as many constraints as your circuit:

| File | Max Constraints | Size |
|------|----------------|------|
| `powersOfTau28_hez_final_14.ptau` | 16,384 | ~54 MB |
| `powersOfTau28_hez_final_15.ptau` | 32,768 | ~108 MB |
| `powersOfTau28_hez_final_16.ptau` | 65,536 | ~216 MB |

For the `ticketcheck` circuit (depth=20, ~20k constraints), use `final_15` or larger:

```bash
# Download Powers of Tau (Phase 1) — ~108 MB
curl -L -o build/pot_final.ptau \
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
```

> **Note**: This file is large but only needed during setup, not at runtime.

---

## Step 9 — Generate Proving Key (Phase 2 Setup)

### 9-a. Initial setup

```bash
snarkjs groth16 setup \
  build/ticketcheck.r1cs \
  build/pot_final.ptau \
  build/ticketcheck_0000.zkey
```

### 9-b. Contribute randomness (Phase 2 ceremony)

For development, a single contribution is sufficient:

```bash
snarkjs zkey contribute \
  build/ticketcheck_0000.zkey \
  build/ticketcheck_final.zkey \
  --name="dev-contribution" \
  -e="$(head -c 64 /dev/urandom | xxd -p -c 256)"
```

> **Production note**: For production use, perform multiple contributions from independent parties
> to ensure the "toxic waste" is destroyed. See the [snarkjs trusted setup documentation](https://github.com/iden3/snarkjs#7-prepare-phase-2).

### 9-c. Verify the final zkey

```bash
snarkjs zkey verify \
  build/ticketcheck.r1cs \
  build/pot_final.ptau \
  build/ticketcheck_final.zkey
```

Expected: `[INFO] snarkJS: ZKey OK!`

---

## Step 10 — Export Verification Key

```bash
snarkjs zkey export verificationkey \
  build/ticketcheck_final.zkey \
  build/verification_key.json
```

This produces `build/verification_key.json` (~3.3 KB), which the backend uses for server-side proof verification.

**Copy to backend:**

```bash
cp build/verification_key.json ../../backend/configs/zkp/verification_key.json
```

---

## Step 11 — Publish Circuit Files and Update Integrity Hashes

### 11-a. Copy WASM to a servable location

The frontend fetches circuit files from `VITE_CIRCUIT_BASE_URL` (default: `/circuits/ticketcheck-v1`):

```bash
# Copy WASM from build output to the public serving directory
mkdir -p ../../frontend/public/circuits/ticketcheck-v1
cp build/ticketcheck_js/ticketcheck.wasm ../../frontend/public/circuits/ticketcheck-v1/ticketcheck.wasm
cp build/ticketcheck_final.zkey          ../../frontend/public/circuits/ticketcheck-v1/ticketcheck.zkey
```

> **Note**: Alternatively, host these files on a CDN and set `VITE_CIRCUIT_BASE_URL` accordingly.

### 11-b. Compute SHA-256 integrity hashes

The frontend verifies circuit file integrity via SHA-256 hashes hardcoded in
`frontend/src/services/proof-service.ts`. After each rebuild, update the hashes:

```bash
sha256sum build/ticketcheck_js/ticketcheck.wasm build/ticketcheck_final.zkey
```

Example output:

```
08de2f44c53230cefcb7d5b4dda5ff829e6afd1fbc52666cb12464a00f5e2f03  build/ticketcheck_js/ticketcheck.wasm
f6cadb4cdeee3c49a5b9b86ae9ac954ee68b52a97ed21f013ff023bfc444a25e  build/ticketcheck_final.zkey
```

Update these values in `frontend/src/services/proof-service.ts`:

```typescript
const CIRCUIT_HASHES: Record<string, string> = {
  'ticketcheck.wasm':
    '08de2f44c53230cefcb7d5b4dda5ff829e6afd1fbc52666cb12464a00f5e2f03',
  'ticketcheck.zkey':
    'f6cadb4cdeee3c49a5b9b86ae9ac954ee68b52a97ed21f013ff023bfc444a25e',
}
```

### 11-c. Configure backend environment variable

Set `ZKP_VERIFICATION_KEY_PATH` so the backend loads the verification key at startup:

**For local development:**

```bash
export ZKP_VERIFICATION_KEY_PATH=./configs/zkp/verification_key.json
```

**For Kubernetes (dev):**

Add to `k8s/namespaces/backend/overlays/dev/server/configmap.env`:

```
ZKP_VERIFICATION_KEY_PATH=/app/configs/zkp/verification_key.json
```

> **Note**: The `verification_key.json` must be baked into the container image (at `configs/zkp/verification_key.json` relative to the app root) or mounted as a ConfigMap/Secret.

### 11-d. Verify the setup

After deploying, confirm the EntryService is registered:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://api.dev.liverty-music.app/liverty_music.rpc.entry.v1.EntryService/GetMerklePath \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"event_id": "e0000000-0000-0000-0000-000000000001"}'

# 200 or 401 or 404 (not_found for missing data) = EntryService registered
# 404 (page not found / no route) = ZKP config missing, service not registered
```

---

# Part C: VAPID Key Generation

VAPID (Voluntary Application Server Identification) keys are used for Web Push notifications.
The backend signs push messages with the private key, and browsers verify the sender using the public key.

## Prerequisites

Install one of:

- **Node.js** (for `web-push` CLI) — recommended, simplest approach
- **openssl** (available on most systems)

---

## Step 12 — Generate VAPID Key Pair

### Option A — Using web-push (recommended)

```bash
npx web-push generate-vapid-keys
```

Example output:

```
=======================================

Public Key:
BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkOs7O6LZmIovecG_xvQ2sDskALwx5cS_3WjqxREso

Private Key:
UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls

=======================================
```

Both keys are in the **URL-safe base64** format expected by the Web Push standard.

### Option B — Using openssl

```bash
# 1. Generate an ECDSA P-256 private key
openssl ecparam -genkey -name prime256v1 -noout -out vapid_private.pem

# 2. Extract the raw private key (32 bytes) as URL-safe base64
openssl ec -in vapid_private.pem -outform DER 2>/dev/null \
  | tail -c +8 | head -c 32 \
  | base64 | tr '+/' '-_' | tr -d '='

# 3. Extract the raw public key (65 bytes, uncompressed) as URL-safe base64
openssl ec -in vapid_private.pem -pubout -outform DER 2>/dev/null \
  | tail -c 65 \
  | base64 | tr '+/' '-_' | tr -d '='

# 4. Clean up
rm vapid_private.pem
```

> **Important**: Save both keys securely. The private key is a secret and must not be committed to version control.

---

## Step 13 — Register VAPID Keys

### 13-a. Store the private key in GCP Secret Manager

The private key is synced to K8s via ExternalSecret (`backend-secrets` → `VAPID_PRIVATE_KEY`).

First, create the secret in GCP Secret Manager:

```bash
# Via Pulumi ESC (preferred)
esc env set liverty-music/dev pulumiConfig.gcp.vapidPrivateKey "<PRIVATE_KEY>" --secret
```

Or via gcloud CLI (if the Secret Manager resource is already provisioned):

```bash
echo -n "<PRIVATE_KEY>" | gcloud secrets versions add vapid-private-key --data-file=-
```

### 13-b. Set the public key in the K8s ConfigMap

The public key is not a secret — it is sent to browsers. Add it to the dev overlay:

Edit `k8s/namespaces/backend/overlays/dev/server/configmap.env`:

```
VAPID_PUBLIC_KEY=BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkOs7O6LZmIovecG_xvQ2sDskALwx5cS_3WjqxREso
```

> **Note**: Replace the value with your actual generated public key.

For the cronjob (concert-discovery), add the same key to
`k8s/namespaces/backend/overlays/dev/cronjob/concert-discovery/configmap.env` if that overlay exists.

### 13-c. Verify the ExternalSecret mapping

The ExternalSecret in `k8s/namespaces/backend/base/server/external-secret.yaml` already maps:

```yaml
- secretKey: VAPID_PRIVATE_KEY
  remoteRef:
    key: vapid-private-key
```

No changes needed — the private key will be synced automatically from GCP Secret Manager.

---

## Step 14 — Verify VAPID Configuration

After deploying the updated ConfigMap:

```bash
# Restart the backend to pick up new env vars
kubectl rollout restart deployment/backend-server -n backend

# Check the pod logs for VAPID warnings
kubectl logs -n backend deployment/backend-server --tail=50 | grep -i vapid
```

If VAPID is configured correctly, there should be **no** warning about missing VAPID keys.

To verify push notifications work end-to-end:

1. Open the frontend and sign in
2. Accept the browser notification permission prompt
3. Trigger an action that sends a push notification (e.g., new concert discovery)
4. Verify the notification appears

---

# Troubleshooting

## Blockchain (Part A)

### `cast: command not found`

```bash
foundryup
exec $SHELL
```

### Faucet says "insufficient on-chain activity"

Try a different faucet from the table in Step 2.

### `pulumi config set` fails with "not logged in"

```bash
pulumi login
```

### Secret already exists in GCP but Pulumi wants to create it

Import the existing secret into Pulumi state:

```bash
pulumi import gcp:secretmanager/secret:Secret blockchain-deployer-private-key \
  projects/<PROJECT_ID>/secrets/blockchain-deployer-private-key
```

### Contract build / deploy issues

See the Troubleshooting section in [backend/contracts/README.md](https://github.com/liverty-music/backend/blob/main/contracts/README.md).

## ZKP Circuit (Part B)

### `circom: command not found`

Ensure Circom was installed via `cargo install`:

```bash
which circom
# Should be in ~/.cargo/bin/circom

# If missing, rebuild:
cd /path/to/circom && cargo install --path circom
```

### `error[T3001]: ... not found` during compilation

Missing circomlib dependency. Ensure `node_modules` is installed:

```bash
cd frontend/circuits/ticketcheck-v1
npm install
```

And pass `-l node_modules` to the `circom` compiler.

### `snarkjs: Error: Powers of Tau is too small`

The `.ptau` file doesn't support enough constraints. Download a larger one (see Step 8 table).

### `ZKey verification failed`

The `.zkey` was corrupted or doesn't match the `.r1cs`. Re-run Steps 9–10 from scratch.

### EntryService returns 404 (not registered)

Check that `ZKP_VERIFICATION_KEY_PATH` is set and the file exists at the specified path inside the container:

```bash
kubectl exec -n backend deployment/backend-server -- ls -la /app/configs/zkp/verification_key.json
```

### Circuit integrity check fails in frontend

The SHA-256 hashes in `proof-service.ts` don't match the served files. Re-compute:

```bash
sha256sum public/circuits/ticketcheck-v1/ticketcheck.wasm
sha256sum public/circuits/ticketcheck-v1/ticketcheck.zkey
```

Update `CIRCUIT_HASHES` in `frontend/src/services/proof-service.ts`.

## VAPID (Part C)

### `npx web-push generate-vapid-keys` fails

Install globally instead:

```bash
npm install -g web-push
web-push generate-vapid-keys
```

### Push notifications not arriving

1. Check that both `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set:
   ```bash
   kubectl exec -n backend deployment/backend-server -- env | grep VAPID
   ```
2. Check that the ExternalSecret is synced:
   ```bash
   kubectl get externalsecret backend-secrets -n backend -o jsonpath='{.status.conditions}'
   ```
3. Verify the browser has granted notification permission (DevTools → Application → Service Workers → Push notifications)

### Key format errors

VAPID keys must be in **URL-safe base64** format (uses `-_` instead of `+/`, no `=` padding).
If using the `openssl` method, ensure the `tr` commands ran correctly.
