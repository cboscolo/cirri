# Farcaster CLI Test Tool (`scripts/fc-test.ts`)

## Overview

Single-file CLI tool for end-to-end testing of the Farcaster write path against a real Hub on mainnet. Tests the full flow: generate signer keys, register on-chain, send casts, update profiles, and verify results.

Run with: `bun scripts/fc-test.ts <command>`

## Commands

| Command | Description |
|---------|-------------|
| `register-fid [--sepolia]` | Register a fresh FID via Privy server wallet (no ETH needed) |
| `keygen` | Generate ed25519 signer keypair |
| `register-signer [--sepolia] [--fid N --custody-key 0x]` | Register signer on-chain via KeyGateway.addFor (Privy pays gas) |
| `register-fname <username>` | Register an fname at fnames.farcaster.xyz (off-chain) |
| `cast "text" [--parent-fid N --parent-hash H]` | Send a cast to the Hub |
| `profile --display "Name" --bio "Bio" [--pfp URL] [--url URL] [--username NAME]` | Update profile fields on the Hub |
| `status` | Query Hub for signers, profile data, and recent casts |

## Quick Start

```bash
# Set Privy credentials (same as apps/signup/.dev.vars)
set -a && source apps/signup/.dev.vars && set +a

# 1. Register a fresh FID (Privy server wallet pays gas + registration fee)
bun scripts/fc-test.ts register-fid

# 2. Generate ed25519 signer keypair
bun scripts/fc-test.ts keygen

# 3. Register signer on-chain (Privy pays gas, uses FID + custody key from state)
bun scripts/fc-test.ts register-signer
# Wait 1-10 minutes for Hub to pick up the on-chain event

# 4. Check Hub sees the signer
bun scripts/fc-test.ts status

# 5. Register an fname
bun scripts/fc-test.ts register-fname myname
bun scripts/fc-test.ts profile --username myname

# 6. Send a cast
bun scripts/fc-test.ts cast "Hello from fid.is!"

# 7. Update profile
bun scripts/fc-test.ts profile --display "Test Name" --bio "Testing bio"

# 8. Verify everything
bun scripts/fc-test.ts status
```

## Environment Variables

Required for `register-fid` and `register-signer` (Privy server wallet):

| Variable | Purpose |
|----------|---------|
| `PRIVY_APP_ID` | Privy application ID |
| `PRIVY_APP_SECRET` | Privy app secret |
| `PRIVY_SERVER_WALLET_ID` | Privy server wallet ID |
| `PRIVY_SERVER_WALLET_ADDRESS` | Privy server wallet address (used for tx simulation) |
| `RECOVERY_ADDRESS` | Recovery address for new FIDs (optional, defaults to custody address) |

These are the same credentials used by `apps/signup/`. For local development, source `apps/signup/.dev.vars`.

## State File

All state is saved to `scripts/.fc-test-state.json` (gitignored — contains private keys):

```json
{
  "fid": 3102061,
  "signerPrivateKey": "...",
  "signerPublicKey": "...",
  "custodyPrivateKey": "0x...",
  "custodyAddress": "0x...",
  "hubApiUrl": "https://haatz.quilibrium.com/v1",
  "network": "mainnet"
}
```

- `hubApiUrl` defaults to `https://haatz.quilibrium.com/v1` if not set
- Edit `hubApiUrl` to use a different Hub
- `network` records whether the FID was registered on mainnet or sepolia

## `--sepolia` Flag

Pass `--sepolia` to `register-fid` and `register-signer` to use OP Sepolia testnet contracts (free testnet ETH, no real cost). Useful for testing the on-chain registration flow.

**Limitation:** Sepolia FIDs are not indexed by mainnet Hubs, so `cast`, `profile`, and `status` commands won't work with Sepolia FIDs.

Contract addresses for each network are hardcoded in the script (matching `apps/signup/.dev.vars` for Sepolia, mainnet defaults for production).

## Imports

The script imports directly from sync service source files:
- `apps/sync/src/crypto.ts` — `hexToBytes`, `bytesToHex`, `generateEd25519Keypair`
- `apps/sync/src/farcaster-message.ts` — `buildCastMessage`, `buildUserDataMessage`
- `apps/sync/src/hub-client.ts` — `submitMessage`
- `apps/sync/src/types.ts` — UserData type constants

On-chain operations use `viem` (dynamically imported) for wallet creation, EIP-712 signing, contract reads, and ABI encoding.

## Bring Your Own FID

If you already have an FID with a custody key, skip `register-fid` and pass flags directly:

```bash
bun scripts/fc-test.ts keygen
bun scripts/fc-test.ts register-signer --fid 1898 --custody-key 0x...
```
