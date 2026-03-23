# Agent Profile Sync — AT Protocol + Farcaster Hub Client

## Status: In Progress

**Branch:** `cboscolo/agent-profile-sync`

## Overview

After agent signup, the agent writes its AT Protocol profile and calls `POST /sync` on the sync service. The sync service extracts profile fields, builds Farcaster `UserDataAdd` messages, signs them with the agent's ed25519 signer key, and submits them to the Hub.

## Completed

- [x] Export `hexToBytes`/`bytesToHex` from `crypto.ts` for shared use
- [x] Create `protobuf.ts` — minimal protobuf wire-format encoder (varint + length-delimited + empty packed fields)
- [x] Create `farcaster-message.ts` — MessageData encoding, BLAKE3 hashing, ed25519 signing
- [x] Create `hub-client.ts` — HTTP client for `POST /v1/submitMessage`
- [x] Add Farcaster protocol constants to `types.ts` (UserData types, message types, epoch, etc.)
- [x] Fill in `syncRecord()` in `sync-do.ts` for `app.bsky.actor.profile`
- [x] Unit tests: protobuf encoder, farcaster message construction + signing, hub client
- [x] Add `@noble/hashes` dependency and vitest to sync package
- [x] Add CastAdd message support (`MESSAGE_TYPE_CAST_ADD = 1`, `encodeCastAddBody`, `buildCastMessage`)
- [x] Add `generateEd25519Keypair()` helper to `crypto.ts`
- [x] End-to-end test against a real Hub with a mainnet FID + registered signer (via `scripts/fc-test.ts`)
- [x] Verified CastAdd and UserDataAdd messages accepted by Hub on mainnet

## Architecture

### Flow
1. Agent writes profile to PDS via `com.atproto.repo.putRecord` (collection: `app.bsky.actor.profile`, rkey: `self`)
2. Agent calls `POST /sync` on the sync service with the profile record
3. Sync service extracts displayName → `USER_DATA_TYPE_DISPLAY(2)`, description → `USER_DATA_TYPE_BIO(3)`, avatar blob ref → `USER_DATA_TYPE_PFP(1)` as PDS blob URL
4. Each field becomes a signed `UserDataAdd` message (BLAKE3 hash + ed25519) submitted to Hub
5. Profile deletion sends empty strings for each type (UserData is last-write-wins)

### Sync Files
- `apps/sync/src/protobuf.ts` — Hand-rolled protobuf encoder (no library dependency)
- `apps/sync/src/farcaster-message.ts` — Farcaster message construction + signing (UserDataAdd + CastAdd)
- `apps/sync/src/hub-client.ts` — HTTP client for Hub API
- `apps/sync/src/crypto.ts` — AES-256-GCM encryption + ed25519 keypair generation
- `apps/sync/src/types.ts` — Farcaster protocol constants

### Test Files
- `apps/sync/test/protobuf.test.ts` — 10 tests
- `apps/sync/test/farcaster-message.test.ts` — 20 tests (12 UserDataAdd + 8 CastAdd)
- `apps/sync/test/hub-client.test.ts` — 4 tests

## Protocol Details Discovered During Testing

### Message Type Values (from Hub protobuf schema)
The Farcaster `MessageType` enum values are:
- `CAST_ADD = 1` (NOT 3 — the original plan had this wrong)
- `CAST_REMOVE = 2`
- `REACTION_ADD = 3`
- `REACTION_REMOVE = 4`
- `LINK_ADD = 5`
- `LINK_REMOVE = 6`
- `VERIFICATION_ADD_ETH_ADDRESS = 7`
- `VERIFICATION_REMOVE = 8`
- `USER_DATA_ADD = 11`

### Message Protobuf Structure
The outer `Message` protobuf requires **both** field 1 (parsed `MessageData` submessage) and field 7 (raw `data_bytes`). The Hub uses field 1 for validation/routing and field 7 for hash/signature verification. Omitting field 1 causes the Hub to misroute the message (e.g., a CastAdd gets validated as a ReactionAdd).

### CastAddBody Required Fields
The Hub's protobuf decoder expects empty packed repeated fields to be present:
- field 2: `mentions` (packed repeated uint64) — must be present even if empty
- field 5: `mentions_positions` (packed repeated uint32) — must be present even if empty

Without these, the Hub fails to parse the CastAddBody correctly.

### Hub Selection
**Do NOT use Pinata hubs** (hub.pinata.cloud) for newly registered FIDs. Pinata's L2 indexer is frequently hundreds of thousands of FIDs behind on Optimism. Use a fully-synced hub instead (e.g., `haatz.quilibrium.com`). Check `numFidRegistrations` in the `/v1/info` response to verify sync status.

### Fname Registration
Fname registration is off-chain — a POST to `fnames.farcaster.xyz/transfers` with an EIP-712 `UserNameProof` signature from the custody key. No on-chain transaction required.

### SignedKeyRequest Metadata Encoding
The metadata for `KeyGateway.addFor()` must be ABI-encoded as a **tuple struct**, not individual parameters:
```typescript
encodeAbiParameters(
  [{ type: "tuple", components: [
    { name: "requestFid", type: "uint256" },
    { name: "requestSigner", type: "address" },
    { name: "signature", type: "bytes" },
    { name: "deadline", type: "uint256" },
  ]}],
  [{ requestFid, requestSigner, signature, deadline }]
)
```

## TODO

- [ ] Support for syncing other collections (feed posts → CastAdd in sync-do.ts)
- [ ] Support for delete/remove messages (currently only profile delete sends empty values)
- [ ] Handle cast text length limits (Farcaster 1024 bytes vs ATProto 300 graphemes)
- [ ] Embed handling (ATProto blob refs → PDS blob URLs in cast embeds)
