# Agent Farcaster Signer Registration — Complete

## Summary

Agents signing up via the signup service now get a Farcaster signer key registered
on-chain in the KeyRegistry. The signer private key is generated and stored by the
**sync service** (`apps/sync/`), encrypted with AES-256-GCM. It never leaves the
sync service.

## Decisions Made

| Question | Decision |
|----------|----------|
| Who generates the key? | Sync service (not the signup service, not the agent) |
| Where is the private key stored? | Encrypted in the sync service's per-FID Durable Object |
| Who is the `requestFid`? | Configurable via `REQUEST_FID` env var (FID 1 on OP Sepolia for testing) |
| Agent-provided vs service-generated? | Service-generated — simpler flow, private key never exposed |
| Bundled into create flow? | Yes — single round-trip for both Register and Add signatures |

## How It Works

1. `GET /api/registration-params` — signup service calls sync service `POST /generate-signer`
   with the agent's address. Sync generates ed25519 keypair, encrypts private key, stores
   in pending DO (`pending:${address}`). Only public key returned.

2. Signup service builds EIP-712 `Add` typed data (KeyGateway) with the public key, plus
   `SignedKeyRequest` metadata signed by the `REQUEST_FID` owner. Returns both `Register`
   and `Add` typed data to the agent.

3. Agent signs both typed data messages.

4. `POST /api/create` — after FID registration, signup service calls `KeyGateway.addFor()`
   via Privy server wallet to register the signer on-chain.

5. Signup service calls sync service `POST /setup` to move the encrypted key from
   `pending:${address}` to `fid:${fid}`.

## Security Model

- Private key generated inside sync service DO, encrypted with AES-256-GCM before storage
- The pending key is looked up by Ethereum address (from x402 payment signature, unforgeable)
- Public key verified during `/setup` — must match what the agent signed in the EIP-712 `Add`
- Both sync service endpoints require `INTERNAL_API_KEY`

## Files

| File | Role |
|------|------|
| `apps/sync/src/sync-do.ts` | `generateSigner()`, `getPendingSignerKey()`, `setupWithEncryptedKey()` |
| `apps/sync/src/crypto.ts` | AES-256-GCM encryption/decryption |
| `apps/sync/src/index.ts` | `POST /generate-signer`, `POST /setup` endpoints |
| `apps/signup/src/index.ts` | Calls sync service, builds EIP-712, calls `addSignerForFid()` |
| `apps/signup/src/farcaster-contracts.ts` | `addSignerForFid()` — KeyGateway interaction via Privy |
| `apps/signup/src/eip712.ts` | `Add` and `SignedKeyRequest` EIP-712 type definitions |

## OP Sepolia Contracts

- KeyRegistry: `0xdE976C4DCF2e723FF34b0A1EaD5c6540c4cd1B47`
- KeyGateway: `0x5d760D4AEDd8d65462b7974a1b0Df4cA07725464`
- SignedKeyRequestValidator: `0x974e9c52C307879ee67ceBb2F40Ba21AFd291529`
