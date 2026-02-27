import { describe, it, expect } from "vitest";
import { CarReader } from "@ipld/car";
import { decodeAll } from "@atproto/lex-cbor";
import {
	env,
	worker,
	runInDurableObject,
	getTestAccountStub,
	seedIdentity,
	testUrl,
	TEST_DID,
	TEST_HANDLE,
	TEST_SIGNING_KEY,
	TEST_SIGNING_KEY_PUBLIC,
} from "./helpers";
import type { AccountDurableObject } from "../src/account-do";
import type {
	SeqCommitEvent,
	SeqIdentityEvent,
} from "../src/sequencer";

/**
 * Decode a firehose frame into header and body.
 * Frames are two concatenated CBOR values: header + body.
 */
function decodeFrame(frame: Uint8Array): { header: unknown; body: unknown } {
	const decoded = [...decodeAll(frame)];
	if (decoded.length !== 2) {
		throw new Error(`Expected 2 CBOR values in frame, got ${decoded.length}`);
	}
	return { header: decoded[0], body: decoded[1] };
}

describe("Firehose (subscribeRepos)", () => {
	describe("WebSocket Upgrade", () => {
		it("should reject non-WebSocket requests", async () => {
			const response = await worker.fetch(
				new Request(testUrl("/xrpc/com.atproto.sync.subscribeRepos")),
				env,
			);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data).toMatchObject({
				error: "InvalidRequest",
			});
		});
	});

	describe("Event Sequencing", () => {
		it("should sequence createRecord events", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcCreateRecord("app.bsky.feed.post", "test-seq-123", {
					text: "Test sequencing",
					createdAt: new Date().toISOString(),
				});

				const seqAfter = sequencer.getLatestSeq();
				expect(seqAfter).toBeGreaterThan(seqBefore);

				const events = await sequencer.getEventsSince(seqBefore, 10);
				expect(events.length).toBeGreaterThan(0);

				const newEvent = events.find((e: any) =>
					e.event.ops?.some(
						(op: any) => op.path === "app.bsky.feed.post/test-seq-123",
					),
				);
				expect(newEvent).toBeDefined();
				if (newEvent) {
					expect(newEvent.type).toBe("commit");
					expect(newEvent.event.repo).toBe(TEST_DID);
					expect(newEvent.event.ops).toHaveLength(1);
					expect(newEvent.event.ops[0]?.action).toBe("create");
				}
			});
		});

		it("should sequence deleteRecord events", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;

				await instance.rpcCreateRecord("app.bsky.feed.post", "to-delete-seq", {
					text: "Will be deleted",
					createdAt: new Date().toISOString(),
				});

				const seqBeforeDelete = sequencer.getLatestSeq();

				await instance.rpcDeleteRecord("app.bsky.feed.post", "to-delete-seq");

				const seqAfterDelete = sequencer.getLatestSeq();
				expect(seqAfterDelete).toBeGreaterThan(seqBeforeDelete);

				const events = await sequencer.getEventsSince(seqBeforeDelete, 10);
				expect(events.length).toBeGreaterThan(0);

				const deleteEvent = events[events.length - 1];
				expect(deleteEvent).toBeDefined();
				if (deleteEvent && deleteEvent.type === "commit") {
					expect(deleteEvent.event.ops).toHaveLength(1);
					expect(deleteEvent.event.ops[0]?.action).toBe("delete");
					expect(deleteEvent.event.ops[0]?.path).toBe(
						"app.bsky.feed.post/to-delete-seq",
					);
				}
			});
		});
	});

	describe("Cursor Validation", () => {
		it("should handle backfill from cursor", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				for (let i = 0; i < 3; i++) {
					await instance.rpcCreateRecord(
						"app.bsky.feed.post",
						`backfill-${i}`,
						{
							text: `Backfill ${i}`,
							createdAt: new Date().toISOString(),
						},
					);
				}

				const events = await sequencer.getEventsSince(seqBefore, 10);
				expect(events.length).toBe(3);
			});
		});
	});

	describe("Event Blocks", () => {
		it("should include CAR blocks with record data in events", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				const result = await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"blocks-test-123",
					{
						$type: "app.bsky.feed.post",
						text: "Test blocks content",
						createdAt: new Date().toISOString(),
					},
				);

				const events = await sequencer.getEventsSince(seqBefore, 10);
				const event = events.find((e: any) =>
					e.event.ops?.some(
						(op: any) => op.path === "app.bsky.feed.post/blocks-test-123",
					),
				);

				expect(event).toBeDefined();
				expect(event!.event.blocks).toBeInstanceOf(Uint8Array);
				expect(event!.event.blocks.length).toBeGreaterThan(0);

				const reader = await CarReader.fromBytes(event!.event.blocks);
				const roots = await reader.getRoots();
				expect(roots.length).toBe(1);

				const commitBlock = await reader.get(roots[0]!);
				expect(commitBlock).toBeDefined();

				const recordCidStr = result.cid;
				let foundRecord = false;
				for await (const block of reader.blocks()) {
					if (block.cid.toString() === recordCidStr) {
						foundRecord = true;
						break;
					}
				}
				expect(foundRecord).toBe(true);
			});
		});

		it("should not have empty blocks in events", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcCreateRecord("app.bsky.feed.post", "non-empty-test", {
					$type: "app.bsky.feed.post",
					text: "Must have blocks",
					createdAt: new Date().toISOString(),
				});

				const events = await sequencer.getEventsSince(seqBefore, 10);
				expect(events.length).toBeGreaterThan(0);

				for (const event of events) {
					if (event.type === "commit") {
						expect(event.event.blocks.length).toBeGreaterThan(50);
					}
				}
			});
		});
	});

	describe("Event Retrieval", () => {
		it("should retrieve events since cursor", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;

				const currentSeq = sequencer.getLatestSeq();

				for (let i = 0; i < 3; i++) {
					await instance.rpcCreateRecord(
						"app.bsky.feed.post",
						`cursor-test-${i}`,
						{
							text: `Post ${i}`,
							createdAt: new Date().toISOString(),
						},
					);
				}

				const events = await sequencer.getEventsSince(currentSeq, 10);
				expect(events.length).toBe(3);

				for (const event of events) {
					expect(event.type).toBe("commit");
					if (event.type === "commit") {
						expect(event.event.repo).toBe(TEST_DID);
					}
				}
			});
		});

		it("should respect limit parameter", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;

				const currentSeq = sequencer.getLatestSeq();

				for (let i = 0; i < 10; i++) {
					await instance.rpcCreateRecord(
						"app.bsky.feed.post",
						`limit-test-${i}`,
						{
							text: `Post ${i}`,
							createdAt: new Date().toISOString(),
						},
					);
				}

				const events = await sequencer.getEventsSince(currentSeq, 5);
				expect(events.length).toBe(5);
			});
		});
	});

	describe("Frame Encoding", () => {
		it("should encode commit events with #commit frame type", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const sequencer = (instance as any).sequencer;
				const encodeEventFrame = (instance as any).encodeEventFrame.bind(
					instance,
				);

				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"frame-type-test",
					{
						text: "Test frame type",
						createdAt: new Date().toISOString(),
					},
				);

				const events = await sequencer.getEventsSince(seqBefore, 1);
				expect(events.length).toBe(1);
				expect(events[0].type).toBe("commit");

				const frame = encodeEventFrame(events[0] as SeqCommitEvent);
				const { header, body } = decodeFrame(frame);

				expect(header).toMatchObject({
					op: 1,
					t: "#commit",
				});
				expect(body).toMatchObject({
					repo: TEST_DID,
				});
			});
		});

		it("should encode identity events with #identity frame type", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const encodeEventFrame = (instance as any).encodeEventFrame.bind(
					instance,
				);

				const identityEvent: SeqIdentityEvent = {
					seq: 1,
					type: "identity",
					event: {
						seq: 1,
						did: TEST_DID,
						handle: TEST_HANDLE,
						time: new Date().toISOString(),
					},
					time: new Date().toISOString(),
				};

				const frame = encodeEventFrame(identityEvent);
				const { header, body } = decodeFrame(frame);

				expect(header).toMatchObject({
					op: 1,
					t: "#identity",
				});
				expect(body).toMatchObject({
					did: TEST_DID,
					handle: TEST_HANDLE,
				});
			});
		});

		it("should dispatch to correct encoder based on event type", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);
				const encodeEventFrame = (instance as any).encodeEventFrame.bind(
					instance,
				);
				const sequencer = (instance as any).sequencer;

				const seqBefore = sequencer.getLatestSeq();

				await instance.rpcCreateRecord(
					"app.bsky.feed.post",
					"dispatch-test",
					{
						text: "Test dispatch",
						createdAt: new Date().toISOString(),
					},
				);

				const events = await sequencer.getEventsSince(seqBefore, 1);
				const commitEvent = events[0] as SeqCommitEvent;

				// Verify commit event gets #commit header
				const commitFrame = encodeEventFrame(commitEvent);
				const commitDecoded = decodeFrame(commitFrame);
				expect((commitDecoded.header as any).t).toBe("#commit");

				// Verify identity event gets #identity header
				const identityEvent: SeqIdentityEvent = {
					...commitEvent,
					type: "identity",
					event: {
						seq: commitEvent.seq,
						did: TEST_DID,
						handle: TEST_HANDLE,
						time: new Date().toISOString(),
					},
				};
				const identityFrame = encodeEventFrame(identityEvent);
				const identityDecoded = decodeFrame(identityFrame);
				expect((identityDecoded.header as any).t).toBe("#identity");
			});
		});
	});

	describe("Identity Events", () => {
		it("should emit identity events with correct frame format", async () => {
			const stub = getTestAccountStub();

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await seedIdentity(instance);

				const result = await instance.rpcEmitIdentityEvent(TEST_HANDLE);

				expect(result).toHaveProperty("seq");
				expect(typeof result.seq).toBe("number");
				expect(result.seq).toBeGreaterThan(0);
			});
		});
	});

	describe("Account Deletion Tombstone", () => {
		it("should return 410 for deleted account firehose", async () => {
			// Use a unique FID to avoid conflicts with other tests
			const did = `did:web:77777.${env.WEBFID_DOMAIN}`;
			const handle = `77777.${env.WEBFID_DOMAIN}`;
			const id = env.ACCOUNT.idFromName(did);
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Seed and delete
				await instance.rpcSetAtprotoIdentity({
					did,
					handle,
					signingKey: TEST_SIGNING_KEY,
					signingKeyPublic: TEST_SIGNING_KEY_PUBLIC,
				});
				await instance.rpcDeleteRepo();

				// Verify account identity still exists but repo is deleted
				expect(await instance.rpcAccountExists()).toBe(true);
				expect(await instance.rpcGetAtprotoIdentity()).not.toBeNull();
				expect(await instance.rpcGetAccountStatus()).toBe("deleted");

				// Call handleFirehoseUpgrade directly
				const request = new Request(
					`http://${handle}/xrpc/com.atproto.sync.subscribeRepos`,
					{ headers: { Upgrade: "websocket" } },
				);
				const response = await (instance as any).handleFirehoseUpgrade(request);

				// Should return 410 Gone
				expect(response.status).toBe(410);
				const body = await response.json();
				expect(body.error).toBe("AccountNotFound");
			});
		});

		it("should return repo status for deleted account without error", async () => {
			const did = `did:web:99999.${env.WEBFID_DOMAIN}`;
			const handle = `99999.${env.WEBFID_DOMAIN}`;
			const id = env.ACCOUNT.idFromName(did);
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Seed identity and create a record so repo is initialized
				await instance.rpcSetAtprotoIdentity({
					did,
					handle,
					signingKey: TEST_SIGNING_KEY,
					signingKeyPublic: TEST_SIGNING_KEY_PUBLIC,
				});
				await instance.rpcCreateRecord("app.bsky.feed.post", "test-post", {
					text: "test",
					createdAt: new Date().toISOString(),
				});

				// Verify repo status works before deletion
				const statusBefore = await instance.rpcGetRepoStatus();
				expect(statusBefore.did).toBe(did);
				expect(statusBefore.active).toBe(true);
				expect(statusBefore.head).toBeTruthy();
				expect(statusBefore.rev).toBeTruthy();

				// Delete the account
				await instance.rpcDeleteRepo();

				// Repo status should still work — returns deleted state
				const statusAfter = await instance.rpcGetRepoStatus();
				expect(statusAfter.did).toBe(did);
				expect(statusAfter.active).toBe(false);
				expect(statusAfter.status).toBe("deleted");
				expect(statusAfter.head).toBe("");
				expect(statusAfter.rev).toBe("");
			});
		});

		it("should return repo status for legacy-deleted account (no identity)", async () => {
			// Simulate an account deleted with the old deleteAll() approach
			// where atproto_identity table is empty
			const did = `did:web:66666.${env.WEBFID_DOMAIN}`;
			const id = env.ACCOUNT.idFromName(did);
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				// Don't seed identity — simulates post-deleteAll state
				// where initSchema recreated empty tables
				const status = await instance.rpcGetRepoStatus();
				expect(status.active).toBe(false);
				expect(status.status).toBe("deleted");
				expect(status.head).toBe("");
				expect(status.rev).toBe("");
			});
		});

		it("should preserve identity after tombstone-preserving deletion", async () => {
			const did = `did:web:88888.${env.WEBFID_DOMAIN}`;
			const handle = `88888.${env.WEBFID_DOMAIN}`;
			const id = env.ACCOUNT.idFromName(did);
			const stub = env.ACCOUNT.get(id);

			await runInDurableObject(stub, async (instance: AccountDurableObject) => {
				await instance.rpcSetAtprotoIdentity({
					did,
					handle,
					signingKey: TEST_SIGNING_KEY,
					signingKeyPublic: TEST_SIGNING_KEY_PUBLIC,
				});

				await instance.rpcDeleteRepo();

				// Identity row preserved (for DID tombstone)
				expect(await instance.rpcGetAtprotoIdentity()).not.toBeNull();
				// Public key cleared
				const pubKey = await instance.rpcGetAtprotoPublicKey();
				expect(pubKey).toBe("");
				// Status is deleted
				expect(await instance.rpcGetAccountStatus()).toBe("deleted");
			});
		});
	});
});
