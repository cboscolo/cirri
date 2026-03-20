/**
 * Farcaster Sync Service — Cloudflare Worker
 *
 * Bridges AT Protocol records to Farcaster messages.
 * Each user gets a SyncDurableObject that stores their encrypted signer key
 * and handles record-to-message transformation.
 *
 * Endpoints:
 * - POST /generate-signer — Generate and store a signer keypair (returns pubkey only)
 * - POST /setup          — Initialize sync for a user (moves pending key to FID-keyed DO)
 * - POST /sync           — Sync a record to Farcaster (called by agent after PDS write)
 * - GET  /status/:fid    — Get sync status
 * - POST /enable/:fid    — Enable sync
 * - POST /disable/:fid   — Disable sync
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, SyncRequest, SetupRequest, GenerateSignerRequest } from "./types";
import type { SyncDurableObject } from "./sync-do";

export { SyncDurableObject } from "./sync-do";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "ServerError", message: err.message }, 500);
});

app.use("*", cors({ origin: "*" }));

/** Get the SyncDurableObject stub for a given FID */
function getSyncDO(env: Env, fid: number): DurableObjectStub<SyncDurableObject> {
	const id = env.SYNC_DO.idFromName(`fid:${fid}`);
	return env.SYNC_DO.get(id) as DurableObjectStub<SyncDurableObject>;
}

/** Get a pending signer DO stub keyed by Ethereum address */
function getPendingDO(env: Env, address: string): DurableObjectStub<SyncDurableObject> {
	const id = env.SYNC_DO.idFromName(`pending:${address.toLowerCase()}`);
	return env.SYNC_DO.get(id) as DurableObjectStub<SyncDurableObject>;
}

/** Verify the internal API key for admin endpoints */
function requireInternalAuth(c: any): boolean {
	const auth = c.req.header("Authorization");
	if (!auth || auth !== `Bearer ${c.env.INTERNAL_API_KEY}`) {
		return false;
	}
	return true;
}

/**
 * POST /generate-signer — Generate an ed25519 signer keypair
 *
 * Generates the keypair inside the sync service, stores the encrypted private key
 * in a pending DO keyed by the Ethereum address. Returns only the public key.
 * The private key never leaves the sync service.
 *
 * Body: { address: "0x..." }
 * Returns: { signerPublicKey: "hex..." }
 */
app.post("/generate-signer", async (c) => {
	if (!requireInternalAuth(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json<GenerateSignerRequest>().catch(() => null);
	if (!body?.address || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
		return c.json(
			{ error: "InvalidRequest", message: "Missing or invalid address" },
			400,
		);
	}

	const stub = getPendingDO(c.env, body.address);
	const result = await stub.generateSigner();
	return c.json(result);
});

/**
 * POST /setup — Initialize sync for a new user
 *
 * Reads the encrypted signer key from the pending DO (keyed by address),
 * moves it to the FID-keyed DO, and clears the pending key.
 *
 * Body: { fid, did, pdsUrl, address, signerPublicKey }
 */
app.post("/setup", async (c) => {
	if (!requireInternalAuth(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json<SetupRequest>().catch(() => null);
	if (!body?.fid || !body?.did || !body?.pdsUrl || !body?.address || !body?.signerPublicKey) {
		return c.json(
			{ error: "InvalidRequest", message: "Missing required fields: fid, did, pdsUrl, address, signerPublicKey" },
			400,
		);
	}

	// Read the pending signer key from the address-keyed DO
	const pendingStub = getPendingDO(c.env, body.address);
	const pendingKey = await pendingStub.getPendingSignerKey();

	if (!pendingKey) {
		return c.json(
			{ error: "NoPendingKey", message: `No pending signer key found for address ${body.address}` },
			404,
		);
	}

	// Verify the public key matches what was generated
	if (pendingKey.publicKey !== body.signerPublicKey) {
		return c.json(
			{ error: "KeyMismatch", message: "Provided signerPublicKey does not match the pending key" },
			400,
		);
	}

	// Move the encrypted key to the FID-keyed DO
	const fidStub = getSyncDO(c.env, body.fid);
	await fidStub.setupWithEncryptedKey({
		fid: body.fid,
		did: body.did,
		pdsUrl: body.pdsUrl,
		signerKeyEncrypted: pendingKey.encrypted,
		signerKeyPublic: pendingKey.publicKey,
	});

	// Clear the pending key
	await pendingStub.clearPendingSignerKey();

	return c.json({ ok: true });
});

/**
 * POST /sync — Sync a record to Farcaster
 *
 * Called by the agent after writing a record to the PDS.
 * Body: { fid, did, action, collection, rkey, record? }
 */
app.post("/sync", async (c) => {
	const body = await c.req.json<SyncRequest>().catch(() => null);
	if (!body?.fid || !body?.did || !body?.action || !body?.collection || !body?.rkey) {
		return c.json(
			{ error: "InvalidRequest", message: "Missing required fields: fid, did, action, collection, rkey" },
			400,
		);
	}

	const stub = getSyncDO(c.env, body.fid);
	const result = await stub.syncRecord(body);
	return c.json(result);
});

/**
 * GET /status/:fid — Get sync status for a user
 */
app.get("/status/:fid", async (c) => {
	if (!requireInternalAuth(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const fid = parseInt(c.req.param("fid"), 10);
	if (isNaN(fid)) {
		return c.json({ error: "InvalidRequest", message: "Invalid FID" }, 400);
	}

	const stub = getSyncDO(c.env, fid);
	const config = await stub.getConfig();

	if (!config) {
		return c.json({ configured: false });
	}

	return c.json({
		configured: true,
		fid: config.fid,
		did: config.did,
		pdsUrl: config.pdsUrl,
		enabled: config.enabled,
		signerKeyPublic: config.signerKeyPublic,
		createdAt: config.createdAt,
	});
});

/**
 * POST /enable/:fid — Enable sync for a user
 */
app.post("/enable/:fid", async (c) => {
	if (!requireInternalAuth(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const fid = parseInt(c.req.param("fid"), 10);
	if (isNaN(fid)) {
		return c.json({ error: "InvalidRequest", message: "Invalid FID" }, 400);
	}

	const stub = getSyncDO(c.env, fid);
	await stub.enable();
	return c.json({ ok: true });
});

/**
 * POST /disable/:fid — Disable sync for a user
 */
app.post("/disable/:fid", async (c) => {
	if (!requireInternalAuth(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const fid = parseInt(c.req.param("fid"), 10);
	if (isNaN(fid)) {
		return c.json({ error: "InvalidRequest", message: "Invalid FID" }, 400);
	}

	const stub = getSyncDO(c.env, fid);
	await stub.disable();
	return c.json({ ok: true });
});

/** Health check */
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
