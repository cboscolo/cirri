/**
 * Test helpers with properly typed env
 */
import { env as _env, exports } from "cloudflare:workers";
export { runInDurableObject } from "cloudflare:test";
import type { PDSEnv } from "../src/types";
import type { AccountDurableObject } from "../src/account-do";
import { createAccessToken } from "../src/session";

// Re-export env with correct type for tests
export const env = _env as PDSEnv;

// Worker fetch using exports.default
export const worker = (
	exports as {
		default: { fetch: (request: Request, env: PDSEnv) => Promise<Response> };
	}
).default;

// ============================================
// Multi-tenant test identity helpers
// ============================================

/** Test FID used across firehose/identity tests */
export const TEST_FID = "12345";

/** Derived test DID: did:web:12345.fid.test */
export const TEST_DID = `did:web:${TEST_FID}.${env.WEBFID_DOMAIN}`;

/** Derived test handle: 12345.fid.test */
export const TEST_HANDLE = `${TEST_FID}.${env.WEBFID_DOMAIN}`;

/** Derived test PDS hostname: pds-12345.fid.test */
export const TEST_PDS_HOSTNAME = `pds-${TEST_FID}.${env.WEBFID_DOMAIN}`;

/** Test signing key (same hex key from vitest.config.ts) */
export const TEST_SIGNING_KEY =
	"e5b452e70de7fb7864fdd7f0d67c6dbd0f128413a1daa1b2b8a871e906fc90cc";

/** Test public key (multibase, from vitest.config.ts) */
export const TEST_SIGNING_KEY_PUBLIC =
	"zQ3shbUq6umkAhwsxEXj6fRZ3ptBtF5CNZbAGoKjvFRatUkVY";

/**
 * Get an Account DO stub routed by the test DID.
 */
export function getTestAccountStub(): DurableObjectStub<AccountDurableObject> {
	const id = env.ACCOUNT.idFromName(TEST_DID);
	return env.ACCOUNT.get(id);
}

/**
 * Seed identity into a DO instance (call inside runInDurableObject).
 * Safe to call multiple times — skips if identity already exists.
 */
export async function seedIdentity(
	instance: AccountDurableObject,
): Promise<void> {
	const hasIdentity = await instance.rpcHasAtprotoIdentity();
	if (!hasIdentity) {
		await instance.rpcSetAtprotoIdentity({
			did: TEST_DID,
			handle: TEST_HANDLE,
			signingKey: TEST_SIGNING_KEY,
			signingKeyPublic: TEST_SIGNING_KEY_PUBLIC,
		});
	}
}

/**
 * Create a JWT access token for the test account.
 * Uses the test DID as both subject and audience.
 */
export async function createTestAccessToken(): Promise<string> {
	return createAccessToken(env.JWT_SECRET, TEST_DID, TEST_DID);
}

/**
 * Build a URL on the test account's subdomain.
 */
export function testUrl(path: string): string {
	return `http://${TEST_PDS_HOSTNAME}${path}`;
}
