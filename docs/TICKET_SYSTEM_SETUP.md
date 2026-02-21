# Ticket System — Secret Setup Guide

This guide walks through generating and registering the three secrets required by the ticket system before running `pulumi up`.

The `TicketSBT` Solidity contract (build, test, deploy) is managed in the `backend` repository.
See [backend/contracts/README.md](https://github.com/liverty-music/backend/blob/main/contracts/README.md) for the full contract workflow.

## Overview

The ticket system uses three secrets stored in GCP Secret Manager:

| Secret name               | Purpose                                                                      |
|---------------------------|------------------------------------------------------------------------------|
| `blockchain-deployer-private-key` | Private key of the EOA that deploys and mints TicketSBT NFTs on Base Sepolia |
| `blockchain-rpc-url`    | JSON-RPC endpoint for the Base Sepolia testnet                               |
| `bundler-api-key`         | ERC-4337 bundler API key (Pimlico or Alchemy Account Kit)                   |

---

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

## Troubleshooting

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
