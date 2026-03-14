# Farcaster-to-ATProto Bridge

## Status: Complete

All phases implemented and deployed.

---

## Phase 1: Core Infrastructure

- `PDSEnv` interface with FID-based configuration
- `atproto_identity` table in DO SQLite storage
- FID-based `getAccountDO()` routing via `idFromName(did)`
- FID extraction from subdomain hostnames

## Phase 2: Authentication

- **Farcaster Quick Auth**: `createFarcasterMini` / `loginFarcasterMini` via `@farcaster/quick-auth`
- **Sign In With Farcaster (SIWF)**: `createAccountSiwf` / `loginSiwf` via `@farcaster/auth-client` + viem
- **Passkeys**: WebAuthn registration/authentication via `@simplewebauthn/server`
- **API key auth**: `POST /xrpc/is.fid.account.create` gated by `ACCOUNT_CREATION_KEY` for trusted services (signup service)
- **Management subdomain** (`my.fid.is`): Serves miniapp and FID management endpoints. Auth tokens scoped to user subdomains (`did:web:NNN.fid.is`), management endpoints only need the `sub` claim.
- Password auth removed (returns "not supported" error)

## Phase 3: DID & Routing

- Dynamic DID document at `/.well-known/did.json`
- Deterministic DID: `did:web:NNN.fid.is`
- Deterministic handle: `NNN.fid.is`
- Wildcard subdomain routing via Cloudflare

## Phase 4: Mini App

Full-featured Farcaster mini app (`apps/miniapp/`) for account management:

- **Stack**: Vite + React, `@farcaster/miniapp-sdk`, `@simplewebauthn/browser`
- **Deployed to**: `my.fid.is`
- **Manifest**: `public/.well-known/farcaster.json` with account association signature

**Features:**
- Account creation via Quick Auth and SIWF
- Login via Quick Auth and SIWF
- Passkey registration, listing, renaming, deletion
- PDS/DID settings (custom PDS URL, verification key)
- Handle management
- Account lifecycle (activate, deactivate, delete)
- Allowlist + waitlist support
- Debug tools (firehose sync, identity/account event emission)

## Account Lifecycle

- Status model: `active` / `deactivated` / `deleted`
- `#account` events emitted on firehose for all state transitions
- Tombstone-preserving deletion (keeps DID + handle, clears data + keys)
- Reconnecting relays receive `#account` tombstone, then connection closes
- Account re-creation after deletion via Quick Auth (new keypair, fresh events)
- HTTP 410 for deleted account operations
- Storage schema migration: `status` TEXT column (replaces boolean `active`)

---

## Files

### Mini App
| File | Purpose |
|------|---------|
| `apps/miniapp/src/App.tsx` | Main component — all UI flows |
| `apps/miniapp/src/api.ts` | PDS API client functions |
| `apps/miniapp/src/main.tsx` | Entry point |
| `apps/miniapp/public/.well-known/farcaster.json` | Farcaster manifest |

### PDS
| File | Purpose |
|------|---------|
| `packages/pds/src/xrpc/fid-account.ts` | Account creation/login/delete endpoints |
| `packages/pds/src/farcaster-auth.ts` | Quick Auth + FID/DID helpers |
| `packages/pds/src/passkey.ts` | WebAuthn registration/authentication |
| `packages/pds/src/session.ts` | JWT access/refresh token creation |

---

## Deployment

Full deployment docs in `apps/fid-pds/README.md`.

### Environment Variables (`wrangler.jsonc` vars)
| Variable | Value | Purpose |
|----------|-------|---------|
| `WEBFID_DOMAIN` | `fid.is` | Base domain for FID subdomains |
| `QUICKAUTH_DOMAIN` | `my.fid.is` | Management subdomain for Quick Auth |
| `INITIAL_ACTIVE` | `true` | Accounts are active on creation |
| `ALLOWLIST_ENABLED` | `true` | Gate new accounts by allowlist |
| `OPTIMISM_RPC_URL` | Alchemy URL | For SIWF verification + contract reads |

### Secrets (`wrangler secret put`)
| Secret | Purpose |
|--------|---------|
| `JWT_SECRET` | Signing key for session JWTs |
| `ACCOUNT_CREATION_KEY` | Shared secret for signup service account creation |

### Bindings
- `ACCOUNT` — Durable Object (`AccountDurableObject`)
- `BLOBS` — R2 bucket (`fid-pds-blobs`)
- `USER_REGISTRY` — D1 database (`fid-pds-registry`)

---

## Local Development

### Cloudflare Tunnel Setup

The miniapp needs a public HTTPS URL for Farcaster authentication. Use a **named Cloudflare tunnel** — quick tunnels get a random subdomain each time, which invalidates the `farcaster.json` account association signature.

```bash
# One-time setup
cloudflared tunnel login
cloudflared tunnel create miniapp
cloudflared tunnel route dns miniapp miniapp.yourdomain.com

# Run (reusable, same hostname every time)
cloudflared tunnel run --url localhost:5173 miniapp
```

### Miniapp `.env.development`

```env
VITE_PDS_URL=https://fid.is
VITE_AUTH_DOMAIN=fid.is
VITE_AUTH_URI=https://fid.is
```
