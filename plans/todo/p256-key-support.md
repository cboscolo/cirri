# P-256 (secp256r1) Key Support

**Status:** ✅ Completed (2026-01-30)

## Overview

Add support for P-256 (secp256r1) signing keys alongside the existing secp256k1 support. This allows PDS operators to choose their preferred elliptic curve for identity keys.

**Why P-256?**
- Included in WebCrypto API (native browser/runtime support)
- Hardware support: TPMs, Secure Enclaves, cloud HSMs
- Required by AT Protocol spec (both curves must be supported for full compliance)

**Reference:** [AT Protocol Cryptography Spec](https://atproto.com/specs/cryptography)

---

## Key Differences Between Curves

| Aspect | secp256k1 (K-256) | secp256r1 (P-256) |
|--------|-------------------|-------------------|
| Multicodec | `secp256k1-pub` (0xE7) | `p256-pub` (0x1200) |
| Varint bytes | `[0xE7, 0x01]` | `[0x80, 0x24]` |
| JWT Algorithm | ES256K | ES256 |
| `did:key` prefix | `zQ3s...` | `zDna...` |
| WebCrypto | No | Yes |
| @atproto/crypto | `Secp256k1Keypair` | `P256Keypair` |

---

## Implementation Tasks

### 1. Key Detection from Public Key Prefix

**File:** `packages/pds/src/types.ts`

The `SIGNING_KEY_PUBLIC` environment variable contains a multibase-encoded public key. We can detect the curve type from the multicodec prefix:

- Prefix `zQ3s` → secp256k1
- Prefix `zDna` → P-256

Add a helper function:

```typescript
type KeyType = 'secp256k1' | 'p256';

function detectKeyType(publicKeyMultibase: string): KeyType {
  if (publicKeyMultibase.startsWith('zQ3s')) return 'secp256k1';
  if (publicKeyMultibase.startsWith('zDna')) return 'p256';
  throw new Error(`Unknown key type for public key: ${publicKeyMultibase.slice(0, 10)}...`);
}
```

### 2. Update Keypair Loading

**File:** `packages/pds/src/index.ts` (lines 65-72)

Update `getKeypair()` to import the correct keypair type based on detected curve:

```typescript
import { Secp256k1Keypair, P256Keypair } from '@atproto/crypto';

async function getKeypair(): Promise<Secp256k1Keypair | P256Keypair> {
  if (keypairCache) return keypairCache;

  const keyType = detectKeyType(env.SIGNING_KEY_PUBLIC);
  keypairCache = keyType === 'p256'
    ? await P256Keypair.import(env.SIGNING_KEY)
    : await Secp256k1Keypair.import(env.SIGNING_KEY);

  return keypairCache;
}
```

**Also update:** `packages/pds/src/account-do.ts` (lines 138, 853)

### 3. Update Service Auth JWT Algorithm

**File:** `packages/pds/src/service-auth.ts`

The JWT algorithm depends on the key type:
- secp256k1 → `ES256K`
- P-256 → `ES256`

The `@atproto/crypto` keypairs expose this via `keypair.jwtAlg`:

```typescript
// Already works - jwtAlg is a property on both keypair types
const header = { alg: keypair.jwtAlg, typ: 'JWT' };
```

Verify that existing code uses `keypair.jwtAlg` (line 76) rather than hardcoding "ES256K".

### 4. Update JWT Verification

**File:** `packages/pds/src/service-auth.ts` (lines 104-163)

The `verifyServiceJwt()` function uses `verifySignature()` from `@atproto/crypto`. This should already support both curves since it resolves the signing key from the DID document. Verify this works correctly.

### 5. Update Key Generation CLI

**File:** `packages/pds/src/cli/utils/secrets.ts`

Add curve type parameter to `generateSigningKeypair()`:

```typescript
export async function generateSigningKeypair(
  keyType: 'secp256k1' | 'p256' = 'secp256k1'
): Promise<{ privateKey: string; publicKey: string }> {
  const keypair = keyType === 'p256'
    ? await P256Keypair.create({ exportable: true })
    : await Secp256k1Keypair.create({ exportable: true });

  const privateKey = await keypair.export();
  const publicKey = keypair.did().replace('did:key:', '');

  return { privateKey, publicKey };
}
```

### 6. Update CLI Key Command

**File:** `packages/pds/src/cli/commands/secret/key.ts`

Add `--curve` option:

```typescript
.option('--curve <type>', 'Key curve type (secp256k1 or p256)', 'secp256k1')
```

### 7. Update Init Command

**File:** `packages/pds/src/cli/commands/init.ts`

Add prompt during init to choose key type (or accept via flag):

```typescript
const keyType = await select({
  message: 'Which signing key algorithm?',
  choices: [
    { name: 'secp256k1 (default, Bitcoin-style)', value: 'secp256k1' },
    { name: 'P-256 (WebCrypto, hardware security)', value: 'p256' },
  ],
});
```

### 8. Update Tests

**Files:**
- `packages/pds/test/cli/key.test.ts`
- `packages/pds/test/service-auth.test.ts`

Add test cases for P-256:
- Key generation with both curves
- Key import/export roundtrip
- Service JWT creation with ES256
- Signature verification

---

## Migration Considerations

### Existing Installations

Existing PDS installations with secp256k1 keys continue to work unchanged. The curve is auto-detected from the public key prefix.

### Changing Key Type

**Warning:** Changing the signing key type means changing your identity key. This requires:

1. PLC directory rotation (for `did:plc`)
2. Updating the DID document (for `did:web`)
3. Coordinating with federation peers

This should be documented as a major identity operation, not a routine config change.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/types.ts` | Add `detectKeyType()` helper |
| `src/index.ts` | Update `getKeypair()` for both curves |
| `src/account-do.ts` | Update keypair loading (2 locations) |
| `src/service-auth.ts` | Verify JWT alg uses `keypair.jwtAlg` |
| `src/cli/utils/secrets.ts` | Add curve parameter to key generation |
| `src/cli/commands/secret/key.ts` | Add `--curve` option |
| `src/cli/commands/init.ts` | Add key type selection |
| `test/cli/key.test.ts` | Add P-256 test cases |
| `test/service-auth.test.ts` | Add P-256 JWT tests |

---

## Verification Checklist

- [x] P256Keypair can be imported from `@atproto/crypto`
- [x] Key type is correctly detected from public key multibase prefix
- [x] Both key types can sign repository commits
- [x] Service JWTs use correct algorithm (ES256K vs ES256)
- [x] DID document includes correct verification method (dynamic context)
- [x] CLI can generate and store P-256 keys (`--curve p256`)
- [x] Existing secp256k1 installations continue working
- [x] Tests cover both curve types (12 new tests)

---

## Dependencies

- `@atproto/crypto` already exports `P256Keypair` (no version change needed)
- No new dependencies required

---

## Priority

**Medium** - Both curves are required for full AT Protocol compliance, but secp256k1 works for all current use cases. P-256 is primarily useful for operators who want hardware security module integration.
