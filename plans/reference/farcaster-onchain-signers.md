# Farcaster On-Chain Signers: Reference

## Overview

Farcaster stores signing keys on Optimism via the **KeyRegistry** contract. Each FID can have multiple ed25519 "account keys" added by apps (e.g., Warpcast, Livecaster). Each key includes metadata identifying which app (`requestFid`) added it.

## Contracts

| Contract | Address (Optimism Mainnet) | Purpose |
|----------|---------------------------|---------|
| IdRegistry | `0x00000000Fc6c5F01Fc30151999387Bb99A9f489b` | FID ownership (`fid → address`, `address → fid`) |
| KeyRegistry | `0x00000000Fc1237824fb747aBDE0FF18990E59b7e` | Signer keys per FID |

## Querying Signers via Hub API

The Snapchain Hub API is the easiest way to get signers with metadata.

**Endpoint:**
```
GET https://haatz.quilibrium.com/v1/onChainSignersByFid?fid={fid}
```

**Response structure:**
```json
{
  "events": [
    {
      "type": "EVENT_TYPE_SIGNER",
      "chainId": 10,
      "blockNumber": 111899004,
      "blockTimestamp": 1699396785,
      "transactionHash": "0x...",
      "fid": 1898,
      "signerEventBody": {
        "key": "0x<64-hex-chars>",
        "keyType": 1,
        "eventType": "SIGNER_EVENT_TYPE_ADD",
        "metadata": "<base64-encoded>",
        "metadataType": 1
      }
    }
  ]
}
```

**Key fields:**
- `signerEventBody.key` — hex-encoded ed25519 public key (32 bytes)
- `signerEventBody.keyType` — `1` = ed25519
- `signerEventBody.eventType` — `SIGNER_EVENT_TYPE_ADD` or `SIGNER_EVENT_TYPE_REMOVE`
- `signerEventBody.metadata` — base64-encoded ABI-encoded `SignedKeyRequestMetadata`
- `signerEventBody.metadataType` — `1` = SignedKeyRequest

## Decoding SignedKeyRequestMetadata

When `metadataType === 1`, the `metadata` field is base64-encoded ABI data for:

```solidity
struct SignedKeyRequestMetadata {
    uint256 requestFid;      // FID of the app that requested the key
    address requestSigner;   // Owner address of the requesting FID
    bytes   signature;       // EIP-712 signature
    uint256 deadline;        // Signature expiry timestamp
}
```

**Decoding with viem:**
```ts
import { decodeAbiParameters } from "viem";

const bytes = Buffer.from(base64Metadata, "base64");
const hex = `0x${bytes.toString("hex")}`;

const [decoded] = decodeAbiParameters(
  [{
    type: "tuple",
    components: [
      { name: "requestFid", type: "uint256" },
      { name: "requestSigner", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  }],
  hex,
);
// decoded.requestFid → bigint (e.g., 9152n for Warpcast)
```

## Querying via Contract Directly

The KeyRegistry contract exposes:
- `keysOf(uint256 fid, uint8 state) → bytes[]` — returns all keys for an FID in a given state
  - State `0` = NULL, `1` = ADDED (active), `2` = REMOVED
- `keyDataOf(uint256 fid, bytes key) → (uint8 state, uint32 keyType)` — per-key state and type

Direct contract calls don't return the `SignedKeyRequestMetadata` — that's only available from Hub event indexing or parsing Optimism transaction logs.

## Example: FID 1898

```
=== Farcaster Signers for FID 1898 ===

--- Signer 0 ---
  Key:       0xe716e5ba961f895f45347482a775b5a44ad89a6661998147f2ed590bd7d4d204
  Key Type:  1 (ed25519)
  Date:      2023-11-07
  requestFid: 9152 (@warpcast)

--- Signer 1 ---
  Key:       0x4a644b94af6e1b5808a4fab2f64eeebd25d84acb94884132d6195609bc59e02c
  Key Type:  1 (ed25519)
  Date:      2025-08-25
  requestFid: 1042739 (@livecaster)
```

## Ed25519 Key Encoding as Multibase

To represent ed25519 keys in a DID document `verificationMethod`:
1. Take 32-byte raw key
2. Prepend multicodec prefix `[0xed, 0x01]` (ed25519-pub)
3. Base58btc encode with `z` prefix → `"z6Mk..."`
4. Use type `"Multikey"` in the verification method

## DID Document Integration (Proposed, Not Implemented)

The proposed structure for including Farcaster identity in the DID document:

**verificationMethod entries:**
- `#farcaster` — custody address as `EcdsaSecp256k1RecoveryMethod2020` with `blockchainAccountId: "eip155:10:{address}"`
- `#farcaster-signer-N` — each ed25519 signer as `Multikey`

**service entries:**
- `#farcaster` — type `Farcaster`, endpoint `https://fname.farcaster.xyz/`
- `#farcaster-signer-N` — type `FarcasterHypersnap`, endpoint `https://haatz.quilibrium.com/v1`

## Test Script

`scripts/query-farcaster-signers.ts` — queries and decodes signers for any FID:
```
npx tsx scripts/query-farcaster-signers.ts [fid]
```

## Related Files

- `packages/pds/src/farcaster-contracts.ts` — existing IdRegistry queries (getCustodyAddress, getFidForAddress)
- `packages/pds/src/index.ts` (lines 182-239) — DID document handler
- `plans/reference/farcaster-hub-api.md` — Hub API general reference
