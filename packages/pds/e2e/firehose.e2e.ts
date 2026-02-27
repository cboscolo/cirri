import { describe, it, expect, beforeAll } from "vitest";
import WebSocket from "ws";
import {
	getBaseUrl,
	getPort,
	TEST_DID,
	TEST_DOMAIN,
	TEST_HOST,
	uniqueRkey,
	createTestJwt,
	seedTestAccount,
	fetchWithHost,
} from "./helpers";

describe("Firehose (subscribeRepos)", () => {
	let accessJwt: string;

	beforeAll(async () => {
		await seedTestAccount();
		accessJwt = await createTestJwt();
	});

	/**
	 * Open a WebSocket to the firehose with the correct Host header.
	 */
	function openFirehose(cursor?: number): WebSocket {
		return openFirehoseForHost(TEST_HOST, cursor);
	}

	function openFirehoseForHost(host: string, cursor?: number): WebSocket {
		const port = getPort();
		const qs = cursor !== undefined ? `?cursor=${cursor}` : "";
		const url = `ws://localhost:${port}/xrpc/com.atproto.sync.subscribeRepos${qs}`;
		return new WebSocket(url, { headers: { "X-Test-Host": host } });
	}

	/**
	 * Wait for a WebSocket to connect, with timeout.
	 */
	function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timeout"));
			}, timeoutMs);
			ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
	}

	/**
	 * Collect messages for a duration, then return them.
	 */
	function collectMessages(
		ws: WebSocket,
		durationMs: number,
	): Promise<Buffer[]> {
		return new Promise((resolve) => {
			const messages: Buffer[] = [];
			ws.on("message", (data: Buffer) => messages.push(data));
			setTimeout(() => resolve(messages), durationMs);
		});
	}

	it("connects to WebSocket endpoint", async () => {
		const ws = openFirehose();
		await waitForOpen(ws);
		ws.close();
	});

	it("returns 400 for non-WebSocket requests", async () => {
		const res = await fetchWithHost(
			"/xrpc/com.atproto.sync.subscribeRepos",
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("InvalidRequest");
	});

	it("emits identity event on first connection (no cursor)", async () => {
		const ws = openFirehose();
		await waitForOpen(ws);

		const messages = await collectMessages(ws, 2000);
		ws.close();

		// Should receive at least the identity event
		expect(messages.length).toBeGreaterThan(0);

		// First message should be an identity event (#identity in CBOR)
		const firstMsg = messages[0]!;
		const hex = firstMsg.toString("hex");
		expect(hex).toContain("236964656e74697479"); // "#identity"
	});

	it("receives commit events when records are created", async () => {
		const ws = openFirehose();
		await waitForOpen(ws);

		// Drain any initial messages (identity event)
		await collectMessages(ws, 500);

		// Start collecting new messages
		const messagesPromise = collectMessages(ws, 2000);

		// Create a record
		const rkey = uniqueRkey();
		const res = await fetchWithHost(
			"/xrpc/com.atproto.repo.createRecord",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessJwt}`,
				},
				body: JSON.stringify({
					repo: TEST_DID,
					collection: "app.bsky.feed.post",
					rkey,
					record: {
						$type: "app.bsky.feed.post",
						text: "Firehose test post",
						createdAt: new Date().toISOString(),
					},
				}),
			},
		);
		expect(res.status).toBe(200);

		const messages = await messagesPromise;
		ws.close();

		// Should have received the commit event
		expect(messages.length).toBeGreaterThan(0);

		// Should be a #commit frame (CBOR)
		const hex = messages[0]!.toString("hex");
		expect(hex).toContain("23636f6d6d6974"); // "#commit"
	});

	it("supports cursor-based backfill", async () => {
		// Create some records to have firehose history
		for (let i = 0; i < 3; i++) {
			const res = await fetchWithHost(
				"/xrpc/com.atproto.repo.createRecord",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${accessJwt}`,
					},
					body: JSON.stringify({
						repo: TEST_DID,
						collection: "app.bsky.feed.post",
						rkey: uniqueRkey(),
						record: {
							$type: "app.bsky.feed.post",
							text: `Backfill test ${i}`,
							createdAt: new Date().toISOString(),
						},
					}),
				},
			);
			expect(res.status).toBe(200);
		}

		// Connect with cursor=0 to get all events from the beginning
		const ws = openFirehose(0);
		await waitForOpen(ws);

		const messages = await collectMessages(ws, 2000);
		ws.close();

		// Should have received multiple backfilled events
		expect(messages.length).toBeGreaterThan(3);
	});

	it("returns 410 for deleted account firehose", async () => {
		const deletedFid = "4";

		// Seed and delete the account
		await seedTestAccount(deletedFid);
		const deleteRes = await fetch(`${getBaseUrl()}/__test/delete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fid: deletedFid }),
		});
		expect(deleteRes.ok).toBe(true);

		// Non-WebSocket request should get 410
		const deletedHost = `${deletedFid}.${TEST_DOMAIN}`;
		const res = await fetchWithHost(
			"/xrpc/com.atproto.sync.subscribeRepos",
			undefined,
			deletedHost,
		);
		expect(res.status).toBe(410);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("AccountNotFound");
	});

	it("closes connection gracefully", async () => {
		const ws = openFirehose();
		await waitForOpen(ws);

		const closePromise = new Promise<void>((resolve) => {
			ws.on("close", () => resolve());
		});

		ws.close();
		await closePromise;

		expect(ws.readyState).toBe(WebSocket.CLOSED);
	});
});
