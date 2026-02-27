import { describe, it, expect } from "vitest";
import {
	env,
	worker,
	runInDurableObject,
	getTestAccountStub,
	seedIdentity,
	createTestAccessToken,
	testUrl,
	TEST_DID,
} from "./helpers";
import type { AccountDurableObject } from "../src/account-do";

describe("gg.mk.experimental.emitIdentityEvent", () => {
	it("requires authentication", async () => {
		const response = await worker.fetch(
			new Request(testUrl("/xrpc/gg.mk.experimental.emitIdentityEvent"), {
				method: "POST",
			}),
			env,
		);

		expect(response.status).toBe(401);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe("AuthMissing");
	});

	it("emits identity event with sequence number", async () => {
		// Seed the account identity first via DO RPC
		const stub = getTestAccountStub();
		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			await seedIdentity(instance);
		});

		// Create a record so the account has data
		const accessToken = await createTestAccessToken();

		await worker.fetch(
			new Request(testUrl("/xrpc/com.atproto.repo.createRecord"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
				},
				body: JSON.stringify({
					repo: TEST_DID,
					collection: "app.bsky.feed.post",
					record: {
						$type: "app.bsky.feed.post",
						text: "Test post for emit identity",
						createdAt: new Date().toISOString(),
					},
				}),
			}),
			env,
		);

		const response = await worker.fetch(
			new Request(testUrl("/xrpc/gg.mk.experimental.emitIdentityEvent"), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			}),
			env,
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { seq: number };
		expect(typeof body.seq).toBe("number");
		expect(body.seq).toBeGreaterThan(0);
	});

	it("can be called multiple times with increasing seq", async () => {
		// Seed the account identity first
		const stub = getTestAccountStub();
		await runInDurableObject(stub, async (instance: AccountDurableObject) => {
			await seedIdentity(instance);
		});

		const accessToken = await createTestAccessToken();

		const response1 = await worker.fetch(
			new Request(testUrl("/xrpc/gg.mk.experimental.emitIdentityEvent"), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			}),
			env,
		);

		expect(response1.status).toBe(200);
		const body1 = (await response1.json()) as { seq: number };

		const response2 = await worker.fetch(
			new Request(testUrl("/xrpc/gg.mk.experimental.emitIdentityEvent"), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			}),
			env,
		);

		expect(response2.status).toBe(200);
		const body2 = (await response2.json()) as { seq: number };
		expect(body2.seq).toBeGreaterThan(body1.seq);
	});
});
