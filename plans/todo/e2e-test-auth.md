# E2E Test Fix Plan

## Summary of Skipped Tests

| File | Tests Skipped | Root Cause |
|------|---------------|------------|
| `crud.e2e.ts` | All (10 tests) | No auth - Farcaster Quick Auth not mocked in tests |
| `blobs.e2e.ts` | All (5 tests) | Same - requires authentication |
| `firehose.e2e.ts` | All (4 tests) | No auth + WebSocket issues in wrangler dev |
| `export.e2e.ts` | 5 of 6 tests | No auth + missing `getLatestCommit` endpoint |
| `session.e2e.ts` | 1 of 2 tests | `describeServer` requires WebFID hostname pattern |

**Total: ~25 tests skipped**

---

## Root Cause Analysis

### How Farcaster Quick Auth Works

1. Client gets JWT from Farcaster (via SIWF flow)
2. Client calls `is.fid.auth.loginFarcasterMini` with the JWT
3. PDS calls `@farcaster/quick-auth` library to verify:
   - Fetches JWKS from `https://auth.farcaster.xyz/.well-known/jwks.json`
   - Verifies JWT signature against those keys
   - Checks issuer = `https://auth.farcaster.xyz`
   - Checks audience = domain
4. PDS extracts FID from `sub` claim and issues AT Protocol tokens

### Current Code (`src/farcaster-auth.ts:19-24`)
```typescript
function getQuickAuthClient(): QuickAuthClient {
	if (!quickAuthClient) {
		quickAuthClient = createClient();  // No origin override!
	}
	return quickAuthClient;
}
```

The quick-auth client is hardcoded to use Farcaster's production auth server.

---

## Implementation Plan: Mock Farcaster Auth for E2E Tests

### Phase 1: Add Configurable Auth Origin

**File: `src/farcaster-auth.ts`**

Modify `getQuickAuthClient()` to accept custom origin:

```typescript
let quickAuthClient: QuickAuthClient | null = null;
let configuredOrigin: string | undefined;

export function configureQuickAuth(origin?: string): void {
	if (origin !== configuredOrigin) {
		quickAuthClient = null;
		configuredOrigin = origin;
	}
}

function getQuickAuthClient(): QuickAuthClient {
	if (!quickAuthClient) {
		quickAuthClient = createClient(
			configuredOrigin ? { origin: configuredOrigin } : undefined
		);
	}
	return quickAuthClient;
}
```

**File: `src/types.ts`**

Add to `PDSEnv`:
```typescript
QUICK_AUTH_ORIGIN?: string;  // Override for testing
```

**File: `src/xrpc/fid-account.ts`**

Call `configureQuickAuth(env.QUICK_AUTH_ORIGIN)` before verification.

### Phase 2: Create Test Auth Server

**File: `e2e/test-auth-server.ts`**

Create a minimal auth server that:
1. Generates an RSA key pair on startup
2. Serves `/.well-known/jwks.json` with the public key
3. Provides a helper to sign test JWTs

```typescript
import { generateKeyPair, SignJWT, exportJWK } from 'jose';

export class TestAuthServer {
	private privateKey: CryptoKey;
	private publicJwk: object;
	private port: number;

	async start(): Promise<string> {
		const { privateKey, publicKey } = await generateKeyPair('RS256');
		this.privateKey = privateKey;
		this.publicJwk = await exportJWK(publicKey);
		// Start HTTP server serving JWKS
		return `http://localhost:${this.port}`;
	}

	async createToken(fid: string, domain: string): Promise<string> {
		return new SignJWT({ sub: fid })
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
			.setIssuer(this.origin)
			.setAudience(domain)
			.setExpirationTime('1h')
			.sign(this.privateKey);
	}
}
```

### Phase 3: Update E2E Test Setup

**File: `e2e/setup.ts`**

1. Start test auth server before Vite
2. Pass `QUICK_AUTH_ORIGIN` to fixture via `.dev.vars`
3. Store auth server instance for token generation

**File: `e2e/helpers.ts`**

Add login helper:
```typescript
export async function loginTestUser(
	agent: AtpAgent,
	fid: string
): Promise<void> {
	const token = await testAuthServer.createToken(fid, 'test.local');

	const response = await fetch(`${getBaseUrl()}/xrpc/is.fid.auth.loginFarcasterMini`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token })
	});

	const { accessJwt, refreshJwt } = await response.json();
	agent.session = { accessJwt, refreshJwt, did: `did:web:${fid}.test.local` };
}
```

### Phase 4: Enable Skipped Tests

Update each test file:
1. Add `await loginTestUser(agent, "1")` in `beforeAll`
2. Remove `.skip` from describe blocks
3. Use `TEST_DID = "did:web:1.test.local"` consistently

### Phase 5: Fix Hostname Issues

**File: `e2e/fixture/.dev.vars`**

Configure test domain:
```
PDS_HOSTNAME=test.local
QUICK_AUTH_ORIGIN=http://localhost:XXXX
```

The test server already runs with a port that we capture - configure routes to accept `test.local` hostnames.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/farcaster-auth.ts` | Add `configureQuickAuth()`, use configurable origin |
| `src/types.ts` | Add `QUICK_AUTH_ORIGIN` to env |
| `src/xrpc/fid-account.ts` | Configure quick auth from env before use |
| `e2e/test-auth-server.ts` | **NEW** - Mock auth server with JWKS |
| `e2e/setup.ts` | Start test auth server, configure env |
| `e2e/helpers.ts` | Add `loginTestUser()` function |
| `e2e/fixture/.dev.vars` | Add `QUICK_AUTH_ORIGIN` |
| `e2e/crud.e2e.ts` | Enable tests, add login |
| `e2e/blobs.e2e.ts` | Enable tests, add login |
| `e2e/export.e2e.ts` | Enable tests where possible |
| `e2e/session.e2e.ts` | Add test for Farcaster auth flow |

---

## Firehose Tests (Separate Issue)

WebSocket tests fail with "socket hang up" in wrangler dev. Options:

1. **Skip for now** - Leave firehose e2e tests skipped, rely on unit tests
2. **Use miniflare directly** - Test WebSocket with miniflare API instead of HTTP
3. **Wait for wrangler fix** - May be a known issue

Recommend: Skip for now, address separately.

---

## Verification

1. `pnpm test` - Unit tests still pass
2. `pnpm test:e2e` - E2E tests now run:
   - `crud.e2e.ts` - All tests pass
   - `blobs.e2e.ts` - All tests pass
   - `export.e2e.ts` - Most tests pass
   - `session.e2e.ts` - Both tests pass
3. Manual test - Real Farcaster auth still works in production

---

## Implementation Order

1. Add configurable auth origin to `farcaster-auth.ts`
2. Create `test-auth-server.ts` with JWKS endpoint
3. Update `setup.ts` to start test auth server
4. Add `loginTestUser()` to helpers
5. Enable `crud.e2e.ts` tests first (most comprehensive)
6. Enable remaining test files one by one
7. Update any hostname-sensitive tests
