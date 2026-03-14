import { describe, it, expect } from "vitest";
import {
	env,
	worker,
	runInDurableObject,
	getTestAccountStub,
	seedIdentity,
	TEST_FID,
	TEST_DID,
} from "./helpers";
import type { AccountDurableObject } from "../src/account-do";

/**
 * Build a URL on any FID's subdomain.
 */
function agentUrl(fid: string, path: string): string {
	return `http://${fid}.${env.WEBFID_DOMAIN}${path}`;
}

describe("is.fid.account.create", () => {
	it("returns 401 when no Authorization header is provided", async () => {
		const response = await worker.fetch(
			new Request(agentUrl("77777", "/xrpc/is.fid.account.create"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ fid: "77777" }),
			}),
			env,
		);

		expect(response.status).toBe(401);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe("AuthenticationRequired");
	});

	it("returns 401 when API key is invalid", async () => {
		const response = await worker.fetch(
			new Request(agentUrl("77777", "/xrpc/is.fid.account.create"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer wrong-key",
				},
				body: JSON.stringify({ fid: "77777" }),
			}),
			env,
		);

		expect(response.status).toBe(401);
	});

	it("returns 400 when fid is missing", async () => {
		const response = await worker.fetch(
			new Request(agentUrl("77777", "/xrpc/is.fid.account.create"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.ACCOUNT_CREATION_KEY}`,
				},
				body: JSON.stringify({}),
			}),
			env,
		);

		expect(response.status).toBe(400);
	});

	it("creates an account with valid API key", async () => {
		const fid = "88888";
		const response = await worker.fetch(
			new Request(agentUrl(fid, "/xrpc/is.fid.account.create"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.ACCOUNT_CREATION_KEY}`,
				},
				body: JSON.stringify({ fid, farcasterAddress: "0x1234567890abcdef1234567890abcdef12345678" }),
			}),
			env,
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.fid).toBe(fid);
		expect(body.did).toBe(`did:web:${fid}.${env.WEBFID_DOMAIN}`);
		expect(body.accessJwt).toBeDefined();
		expect(body.refreshJwt).toBeDefined();
		expect(body.active).toBe(true);
	});
});

describe("createAccountForFid shared helper (via DO RPC)", () => {
	it("verifies account does not exist before creation", async () => {
		const testFid = "99999";
		const testDid = `did:web:${testFid}.${env.WEBFID_DOMAIN}`;
		const id = env.ACCOUNT.idFromName(testDid);
		const stub = env.ACCOUNT.get(id);

		const exists = await stub.rpcAccountExists();
		expect(exists).toBe(false);
	});

	it("handles idempotent creation (account already exists)", async () => {
		const stub = getTestAccountStub();
		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			await seedIdentity(instance);
		});

		const exists = await stub.rpcAccountExists();
		expect(exists).toBe(true);

		const identity = await stub.rpcGetAtprotoIdentity();
		expect(identity).not.toBeNull();
		expect(identity?.did).toBe(TEST_DID);
	});
});
