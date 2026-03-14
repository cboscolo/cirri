# Service Keys: Third-Party Service Authentication for PDS

## Context

Third-party services (e.g., a Farcaster cast importer) need to make authenticated write API calls to a user's PDS. Existing auth mechanisms don't fit:

- **OAuth 2.1** — requires browser redirect flow, too heavy for service-to-service
- **Session JWTs** — tied to user login sessions, not delegated service access
- **Farcaster Quick Auth / SIWF** — only for the account owner

We need a way for users to grant scoped, revocable API access to services using keypair-based authentication.

## Design: Service Keys via AT Protocol Identity

A **service** is an AT Protocol account (has a DID, signing key, and repo). Users grant services access by registering the service's DID in their PDS. The service's public key comes from its DID document — no separate key exchange needed.

### How It Works

1. **Service** has its own AT Protocol identity (e.g., `did:web:cast-importer.fid.is`)
2. **Service** publishes metadata in its repo: name, description, requested scopes
3. **User** enters the service's handle/DID in the miniapp
4. **Miniapp** resolves the DID, fetches the DID document (gets public key) and metadata record (gets name, scopes)
5. **User** reviews and approves — PDS stores the service DID + public key + granted scopes
6. **Service** signs JWTs with its private key to make API calls
7. **PDS** verifies JWTs against the stored public key and checks scopes

### Service Identity & Metadata

The service is an AT Protocol account. Its public key is in its DID document's `verificationMethod[0].publicKeyMultibase`. Its metadata is published as a record:

**Collection:** `is.fid.service.metadata` (custom NSID)
**Record key:** `self`
**Record value:**
```json
{
  "$type": "is.fid.service.metadata",
  "name": "Farcaster Cast Importer",
  "description": "Imports your Farcaster casts as Bluesky posts",
  "requestedScopes": [
    "repo:app.bsky.feed.post",
    "blob"
  ]
}
```

The miniapp fetches this via `com.atproto.repo.getRecord` on the service's PDS — standard AT Protocol, works across any PDS.

### Scope Format

Following the [Bluesky OAuth scope proposal](https://github.com/bluesky-social/proposals/tree/main/0011-auth-scopes):

| Scope | Meaning |
|-------|---------|
| `repo:app.bsky.feed.post` | Create/update/delete post records |
| `repo:app.bsky.actor.profile` | Create/update/delete profile records |
| `repo:*` | All record types |
| `blob` | Upload blobs |

For v1 we support `repo:COLLECTION` and `blob`. The `action` parameter (create/update/delete) and `rpc:` scopes can be added later.

**Scope granting:** The user can grant a subset of what the service requests. The miniapp shows the requested scopes and lets the user approve/deny each one.

### Service JWT Format

```
Header: { alg: "ES256K", typ: "service+jwt" }
Payload: {
  iss: "<service_did>",      // Service's DID (e.g., did:web:cast-importer.fid.is)
  sub: "<user_did>",         // User's DID (whose PDS is being accessed)
  aud: "<user_did>",         // PDS service DID (same as sub for WebFID)
  exp: <timestamp>,          // Max 5 minutes
  iat: <timestamp>,
  jti: "<nonce>"             // Unique per request
}
```

Uses ES256K (Secp256k1) — same as existing `service-auth.ts`. The `iss` is the service's DID (not a UUID), making the system self-describing.

### User Experience

**Adding a service (miniapp):**
1. User navigates to Settings → Service Keys
2. Enters the service's handle (e.g., `cast-importer.fid.is`) or DID
3. Miniapp resolves the DID document → gets public key
4. Miniapp fetches `is.fid.service.metadata/self` from the service's repo → gets name, description, requested scopes
5. User sees: "**Farcaster Cast Importer** requests access to: Create posts, Upload images"
6. User approves (can deselect specific scopes)
7. PDS stores: service DID, public key, granted scopes

**Revoking access:** User deletes the service key from Settings → Service Keys list.

### Example: Farcaster Cast Importer

**Service setup (one-time):**
- Service creates an AT Protocol account (e.g., on fid.is or any PDS)
- Publishes `is.fid.service.metadata/self` record with name and requested scopes
- Stores its signing key securely

**User grants access:**
- Enters `cast-importer.fid.is` in miniapp
- Sees "Farcaster Cast Importer requests: Create posts, Upload blobs"
- Approves

**Service makes API calls:**
```typescript
const jwt = sign({
  iss: "did:web:cast-importer.fid.is",
  sub: "did:web:12345.fid.is",
  aud: "did:web:12345.fid.is",
  exp: now + 300,
  iat: now,
  jti: crypto.randomUUID(),
}, servicePrivateKey);

fetch("https://pds-12345.fid.is/xrpc/com.atproto.repo.createRecord", {
  method: "POST",
  headers: { Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({
    repo: "did:web:12345.fid.is",
    collection: "app.bsky.feed.post",
    record: { $type: "app.bsky.feed.post", text: "Hello from Farcaster!", createdAt: "..." },
  }),
});
```

## Implementation

### Storage (`packages/pds/src/storage.ts`)

New table in `initSchema()` migration:

```sql
CREATE TABLE IF NOT EXISTS service_keys (
    service_did TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '["repo:*","blob"]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);
```

Keyed by service DID (not UUID) since the service is an AT Protocol identity.

CRUD methods following passkey pattern (`storage.ts` lines 599-699):
- `saveServiceKey(serviceDid, name, publicKey, scopes)`
- `getServiceKey(serviceDid)` → row or null
- `listServiceKeys()` → `{ serviceDid, name, scopes, createdAt, lastUsedAt }[]`
- `deleteServiceKey(serviceDid)` → boolean
- `updateServiceKeyLastUsed(serviceDid)`

Add `DELETE FROM service_keys` to `clearBulkData()` for account deletion.

### Account DO (`packages/pds/src/account-do.ts`)

RPC wrappers following passkey pattern (lines 1622-1675):
- `rpcSaveServiceKey(serviceDid, name, publicKey, scopes)`
- `rpcGetServiceKey(serviceDid)` → `Rpc.Serializable<ServiceKeyRow | null>`
- `rpcListServiceKeys()` → `Rpc.Serializable<ServiceKeyInfo[]>`
- `rpcDeleteServiceKey(serviceDid)` → boolean
- `rpcUpdateServiceKeyLastUsed(serviceDid)`

### JWT Verification (`packages/pds/src/service-key-auth.ts` — new)

Modeled on `service-auth.ts`:

```typescript
export async function verifyServiceKeyJwt(
    token: string,
    publicKeyMultibase: string,
    expectedSubject: string,
): Promise<{ iss: string; sub: string }>
```

- Validates: `typ === "service+jwt"`, signature via `@atproto/crypto` `verifySignature`, expiry (max 5 min), `sub` matches expected user DID
- Returns `iss` (service DID) for scope lookup

### Auth Middleware (`packages/pds/src/middleware/auth.ts`)

Extend `requireAuth` to handle service key JWTs:

1. Extract `Authorization: Bearer <token>`
2. Peek at JWT header (base64-decode first segment)
3. If `typ === "at+jwt"` → existing session JWT path
4. If `typ === "service+jwt"` → new path:
   - Decode payload to get `iss` (service DID) and `sub` (user DID)
   - Get account DO for the user DID
   - Look up service key by `iss` (service DID)
   - Verify signature against stored public key
   - Check scopes against requested operation:
     - Extract XRPC method from URL path
     - For `createRecord`/`putRecord`/`deleteRecord`: extract collection from request body → check `repo:COLLECTION` scope
     - For `uploadBlob`: check `blob` scope
   - Update `last_used_at`
   - Set `c.set("did", sub)` and `c.set("authType", "service-key")`
5. Otherwise → reject 401

**Scope checking detail:** For write endpoints, the middleware needs to read the request body to get the collection. Since Hono allows `c.req.json()` (and caches it), this is safe. The middleware checks:
- `scopes.includes("repo:*")` → allows any repo operation
- `scopes.includes("repo:" + collection)` → allows specific collection
- `scopes.includes("blob")` → allows blob upload

### XRPC Endpoints (`packages/pds/src/xrpc/fid-service-keys.ts` — new)

Following `fid-settings.ts` pattern:

| Endpoint | Auth | Input | Output |
|----------|------|-------|--------|
| `POST is.fid.serviceKeys.add` | Bearer JWT | `{ serviceDid, name, publicKey, scopes }` | `{ serviceDid, name, scopes }` |
| `GET is.fid.serviceKeys.list` | Bearer JWT | — | `{ serviceKeys: [...] }` |
| `POST is.fid.serviceKeys.delete` | Bearer JWT | `{ serviceDid }` | `{ success: true }` |

The miniapp does the DID resolution and metadata fetching client-side, then sends the resolved data to the PDS. The PDS just stores it.

### Route Registration (`packages/pds/src/index.ts`)

After settings routes (~line 388):
```typescript
app.post("/xrpc/is.fid.serviceKeys.add", requireAuth, ...);
app.get("/xrpc/is.fid.serviceKeys.list", requireAuth, ...);
app.post("/xrpc/is.fid.serviceKeys.delete", requireAuth, ...);
```

### Miniapp API (`apps/miniapp/src/api.ts`)

- `resolveServiceMetadata(handleOrDid)`:
  1. Resolve handle to DID if needed (via `/.well-known/atproto-did`)
  2. Fetch DID document → extract public key from `verificationMethod[0].publicKeyMultibase`
  3. Resolve PDS endpoint from DID document's `service` field
  4. Fetch `com.atproto.repo.getRecord?repo=DID&collection=is.fid.service.metadata&rkey=self` from the service's PDS
  5. Return `{ did, name, description, publicKey, requestedScopes }`
- `addServiceKey(serviceDid, name, publicKey, scopes)` — POST to PDS
- `listServiceKeys()` — GET from PDS
- `deleteServiceKey(serviceDid)` — POST to PDS

### Miniapp UI (`apps/miniapp/src/App.tsx`)

**`ServiceKeysSection`** component in settings:
- Lists registered service keys with name, scopes, last used, delete button
- "Add Service" form: text input for handle/DID, fetches metadata on submit
- Approval screen: shows service name, description, requested scopes with checkboxes
- Confirm → calls `addServiceKey()`

## Files Summary

| File | Action |
|------|--------|
| `packages/pds/src/storage.ts` | Add `service_keys` table + CRUD |
| `packages/pds/src/account-do.ts` | Add RPC wrappers |
| `packages/pds/src/service-key-auth.ts` | **New** — JWT verification |
| `packages/pds/src/middleware/auth.ts` | Extend `requireAuth` |
| `packages/pds/src/xrpc/fid-service-keys.ts` | **New** — management endpoints |
| `packages/pds/src/index.ts` | Register routes |
| `apps/miniapp/src/api.ts` | Metadata resolution + API functions |
| `apps/miniapp/src/App.tsx` | Service keys UI |
| `packages/pds/test/service-keys.test.ts` | **New** — tests |

## Security

- **No shared secrets** — PDS stores public keys from DID documents
- **Short-lived tokens** — 5 minute max expiry, enforced server-side
- **Scoped access** — per-collection granularity following Bluesky scope format
- **Revocable** — users delete service keys from miniapp
- **Self-describing** — service identity is verifiable via AT Protocol DID resolution
- **Distinct token type** — `typ: "service+jwt"` prevents confusion with session JWTs

## Decision: Bearer JWTs (not RFC 9421 HTTP Message Signatures)

We evaluated three approaches:

1. **RFC 9421 HTTP Message Signatures** — stronger security (body integrity, per-request binding) but significantly more complex for both client and server. JS library ecosystem is immature, and secp256k1 isn't in RFC 9421's algorithm registry.
2. **Hybrid (JWTs + RFC 9421)** — support both mechanisms. Adds implementation burden without clear benefit since we control both sides.
3. **Bearer JWTs** — simple, well-understood, matches AT Protocol's existing inter-service auth pattern (PDS→AppView service JWTs). Easy to debug (jwt.io). Battle-tested libraries.

**Chosen: Option 3 (Bearer JWTs).** Rationale:
- AT Protocol already uses service JWTs for inter-service auth — this is the established pattern
- 5-minute expiry + jti nonces provide sufficient replay protection for our threat model
- Simple for service developers to implement (sign a JSON payload, send as Bearer token)
- Easy to debug and inspect
- RFC 9421 can be revisited later if we add ActivityPub federation or need body integrity guarantees

## Verification

1. `pnpm test` — existing + new service key tests pass
2. Manual: register a service key for a test service DID
3. Manual: create a signed JWT, call `createRecord` for an allowed collection — succeeds
4. Manual: call `createRecord` for a collection not in scopes — rejected 403
5. Manual: delete the service key, retry — rejected 401
6. Manual: use an expired JWT — rejected 401
