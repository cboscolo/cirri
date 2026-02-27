import { readFileSync } from "node:fs";
import { AtpAgent } from "@atproto/api";
import { Secp256k1Keypair } from "@atproto/crypto";
import { SignJWT } from "jose";
import { PORT_FILE } from "./setup";

export function getPort(): number {
	try {
		return parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
	} catch {
		return 5173;
	}
}

export function getBaseUrl(): string {
	return `http://localhost:${getPort()}`;
}

export function createAgent(): AtpAgent {
	return new AtpAgent({ service: getBaseUrl() });
}

/**
 * Generate a unique rkey for test isolation
 */
export function uniqueRkey(): string {
	return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Test credentials for WebFID format: did:web:NNN.domain where NNN is a FID
export const TEST_DOMAIN = "test.local";
export const TEST_FID = "1";
export const TEST_DID = `did:web:${TEST_FID}.${TEST_DOMAIN}`;
export const TEST_HANDLE = `${TEST_FID}.${TEST_DOMAIN}`;
export const TEST_HOST = `pds-${TEST_FID}.${TEST_DOMAIN}`;
export const JWT_SECRET = "test-jwt-secret-at-least-32-chars-long";

/**
 * Create an access JWT for test authentication.
 * Uses the known JWT_SECRET from the test fixture's .dev.vars.
 */
export async function createTestJwt(
	did: string = TEST_DID,
	audience: string = TEST_DID,
): Promise<string> {
	const secret = new TextEncoder().encode(JWT_SECRET);

	return new SignJWT({ scope: "com.atproto.access" })
		.setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
		.setIssuedAt()
		.setAudience(audience)
		.setSubject(did)
		.setExpirationTime("1h")
		.sign(secret);
}

/**
 * Seed a test account in the DO without Farcaster auth.
 * Generates a signing keypair and calls the test-only /__test/seed endpoint.
 */
export async function seedTestAccount(
	fid: string = TEST_FID,
): Promise<{ did: string; handle: string }> {
	const keypair = await Secp256k1Keypair.create({ exportable: true });
	const signingKeyBytes = await keypair.export();
	const signingKey = Array.from(signingKeyBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const signingKeyPublic = keypair.did().replace("did:key:", "");

	const res = await fetch(`${getBaseUrl()}/__test/seed`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fid, signingKey, signingKeyPublic }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to seed account: ${res.status} ${body}`);
	}
	return res.json() as Promise<{ did: string; handle: string }>;
}

/**
 * Make a fetch request with the Host header set to the test subdomain.
 * This routes the request through the PDS hostname-based routing.
 */
export function fetchWithHost(
	path: string,
	init?: RequestInit,
	host: string = TEST_HOST,
): Promise<Response> {
	const url = `${getBaseUrl()}${path}`;
	return fetch(url, {
		...init,
		headers: {
			...init?.headers,
			"X-Test-Host": host,
		},
	});
}
