# SIWE (Sign In With Ethereum) Authentication for fid.is

## Context

Users who don't have the Farcaster app (Warpcast) can't authenticate to their fid.is account — both existing auth flows (Quick Auth, SIWF) require Warpcast. With the new signup service creating accounts for agents and non-Farcaster users, we need a Warpcast-free auth path.

SIWE (EIP-4361) is the right primitive: it's what SIWF does under the hood (sign a message with the FID's custody key), just without the Warpcast relay. viem (already a PDS dependency) has built-in SIWE support (`verifySiweMessage`, `parseSiweMessage`).

**Auth method preference per account:**
- Accounts created via SIWF/Quick Auth → default to SIWF in OAuth consent UI
- Accounts created via `is.fid.account.create` (signup service) → default to SIWE in OAuth consent UI
- Users can change their preference via a settings endpoint

## Implementation

### 1. Storage: `auth_method` column on `atproto_identity`

**File:** `packages/pds/src/storage.ts`

Add migration (same pattern as `custom_pds_url` at line 130):
```sql
ALTER TABLE atproto_identity ADD COLUMN auth_method TEXT DEFAULT 'siwf'
```

Values: `"siwf"` (default for existing accounts) or `"siwe"`.

Add methods:
- `getAuthMethod(): string`
- `setAuthMethod(method: string): void`

### 2. DO RPC methods

**File:** `packages/pds/src/account-do.ts`

- `rpcGetAuthMethod(): Promise<string>`
- `rpcSetAuthMethod(method: string): Promise<void>`

### 3. Set auth_method during account creation

**File:** `packages/pds/src/xrpc/fid-account.ts`

- `createAccountForFid()` — add `authMethod?: string` to options, call `rpcSetAuthMethod()` after identity creation
- `createAccountFarcasterMini()` / `createAccountSiwf()` — pass `authMethod: "siwf"`
- `createAccount()` (API key endpoint) — pass `authMethod: "siwe"`

### 4. SIWE verification callback in OAuth provider

**File:** `packages/oauth-provider/src/provider.ts`

Add to `OAuthProviderConfig`:
```ts
verifySiwe?: (message: string, signature: string) => Promise<{ sub: string; handle: string } | null>;
```

Add `handleSiweAuth(request)` — same pattern as `handleSiwfAuth()` (line 895). Parses `{ message, signature, oauthParams }`, calls `verifySiwe`, then `completeAuthWithRedirect()`.

### 5. Wire SIWE into OAuth consent flow

**File:** `packages/pds/src/oauth.ts`

In `createProvider()` (line 142), add `verifySiwe` callback:
- Use viem's `verifyMessage()` to recover signer address (pure crypto, no RPC)
- Use `getCustodyAddress(fid, rpcUrl)` from `farcaster-contracts.ts` to verify signer owns the FID
- Return `{ sub: ctx.did, handle: ctx.handle }` on success

Add route:
```ts
oauth.post("/oauth/siwe-auth", ...);
```

Pass `authMethod` preference to provider — read from `ctx.accountDO.rpcGetAuthMethod()` and forward to `renderConsentUI()`.

### 6. OAuth consent UI: add SIWE button with preference ordering

**File:** `packages/oauth-provider/src/ui.ts`

Add `siweAvailable` and `preferredAuthMethod` to `ConsentUIOptions`.

Button ordering based on `preferredAuthMethod`:
- `"siwe"` → SIWE first, then passkey, then SIWF
- `"siwf"` (default) → SIWF first, then passkey, then SIWE

SIWE button client-side JS:
1. Check `window.ethereum` exists
2. Request accounts via `eth_requestAccounts`
3. Construct SIWE message (domain, address, nonce, chain ID, URI)
4. Call `personal_sign` to get signature
5. POST to `/oauth/siwe-auth` with `{ message, signature, oauthParams }`
6. Follow redirect URL from response

### 7. Direct login endpoint (non-OAuth)

**File:** `packages/pds/src/xrpc/fid-account.ts`

Add `loginSiwe()` — same pattern as `loginSiwf()` (line 421):
- Body: `{ message: string, signature: string }`
- Verify signature with viem `verifyMessage()`
- Derive FID from request subdomain
- Look up custody address via `getCustodyAddress()`
- Verify signer === custody address
- Return session tokens

**File:** `packages/pds/src/index.ts`

```ts
app.post("/xrpc/is.fid.auth.loginSiwe", (c) => fidAccount.loginSiwe(c, getAccountDO));
```

### 8. Settings endpoints for auth method

**File:** `packages/pds/src/xrpc/fid-settings.ts`

- `getAuthMethod()` — `GET /xrpc/is.fid.settings.getAuthMethod` → `{ authMethod: "siwf" | "siwe" }`
- `setAuthMethod()` — `POST /xrpc/is.fid.settings.setAuthMethod` body `{ authMethod: "siwf" | "siwe" }`

**File:** `packages/pds/src/index.ts` — wire routes (same pattern as `getPdsUrl`/`setPdsUrl`).

## Files to modify

| File | Change |
|------|--------|
| `packages/pds/src/storage.ts` | `auth_method` column migration + get/set methods |
| `packages/pds/src/account-do.ts` | `rpcGetAuthMethod()` / `rpcSetAuthMethod()` |
| `packages/pds/src/xrpc/fid-account.ts` | `authMethod` in `createAccountForFid()`, add `loginSiwe()` |
| `packages/pds/src/xrpc/fid-settings.ts` | `getAuthMethod()` / `setAuthMethod()` endpoints |
| `packages/pds/src/oauth.ts` | `verifySiwe` callback, `/oauth/siwe-auth` route, pass preference |
| `packages/pds/src/index.ts` | `loginSiwe` route, auth method settings routes |
| `packages/oauth-provider/src/provider.ts` | `verifySiwe` config + `handleSiweAuth()` |
| `packages/oauth-provider/src/ui.ts` | SIWE button, `preferredAuthMethod` ordering, client-side JS |

## No new dependencies

- viem `verifyMessage()` — pure secp256k1 ecrecover, no RPC needed
- `getCustodyAddress()` — already exists in `packages/pds/src/farcaster-contracts.ts`

## Verification

1. **Unit tests**: `loginSiwe` with valid/invalid signature (mock `getCustodyAddress`)
2. **Unit tests**: `createAccount` sets `auth_method: "siwe"`, `createAccountSiwf` sets `"siwf"`
3. **Unit tests**: `getAuthMethod`/`setAuthMethod` settings endpoints
4. **Manual**: OAuth consent UI shows correct default button order per account preference
5. **Manual**: Full SIWE login — sign with wallet, verify session tokens
