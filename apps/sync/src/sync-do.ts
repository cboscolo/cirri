/**
 * SyncDurableObject — per-user Durable Object that handles Farcaster sync.
 *
 * Two keying modes:
 * - `fid:${fid}` — active sync config for a user (stores encrypted signer key, mappings)
 * - `pending:${address}` — temporary storage for a generated signer key awaiting FID assignment
 *
 * Stores the user's encrypted ed25519 signer key and sync configuration.
 * Receives record events from the agent (via POST /sync) and submits
 * corresponding Farcaster messages to the Hub.
 */

import { DurableObject } from "cloudflare:workers";
import { encryptSignerKey, decryptSignerKey, bytesToHex } from "./crypto";
import { buildUserDataMessage } from "./farcaster-message";
import { submitMessage } from "./hub-client";
import type { Env, SyncConfig, SyncRequest, SetupRequest, UserDataType } from "./types";
import { USER_DATA_TYPE_PFP, USER_DATA_TYPE_DISPLAY, USER_DATA_TYPE_BIO } from "./types";

export class SyncDurableObject extends DurableObject<Env> {
	private initialized = false;

	private ensureSchema() {
		if (this.initialized) return;

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS sync_config (
				fid INTEGER PRIMARY KEY,
				did TEXT NOT NULL,
				pds_url TEXT NOT NULL,
				signer_key_encrypted TEXT NOT NULL,
				signer_key_public TEXT NOT NULL,
				enabled INTEGER DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT
			)
		`);

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS sync_mapping (
				atproto_rkey TEXT NOT NULL,
				collection TEXT NOT NULL,
				farcaster_hash TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (collection, atproto_rkey)
			)
		`);

		// Pending signer keys (used by pending:${address} DOs)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS pending_signer (
				id INTEGER PRIMARY KEY DEFAULT 1,
				signer_key_encrypted TEXT NOT NULL,
				signer_key_public TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		this.initialized = true;
	}

	/**
	 * Generate an ed25519 signer keypair, encrypt and store the private key.
	 * Used by pending:${address} DOs — the key is held here until /setup moves it
	 * to the FID-keyed DO.
	 */
	async generateSigner(): Promise<{ signerPublicKey: string }> {
		this.ensureSchema();

		const { ed25519 } = await import("@noble/curves/ed25519.js");

		const privateKey = ed25519.utils.randomSecretKey();
		const publicKey = ed25519.getPublicKey(privateKey);

		// Convert to hex
		const privKeyHex = Array.from(privateKey)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const pubKeyHex = Array.from(publicKey)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		// Encrypt the private key
		const encryptedKey = await encryptSignerKey(privKeyHex, this.env.SIGNER_ENCRYPTION_KEY);

		// Store the pending key. If one already exists, replace it — the latest
		// /registration-params call wins (previous keys become orphaned but harmless).
		// The pubkey is later verified during /setup against what the agent signed
		// in the EIP-712 Add message, so a spoofed /registration-params call can't
		// steal another user's signer key — it would just cause a KeyMismatch error.
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO pending_signer (id, signer_key_encrypted, signer_key_public)
			 VALUES (1, ?, ?)`,
			encryptedKey,
			pubKeyHex,
		);

		return { signerPublicKey: pubKeyHex };
	}

	/**
	 * Get the pending encrypted signer key (for transfer to a FID-keyed DO during setup).
	 * Returns null if no pending key exists.
	 */
	getPendingSignerKey(): { encrypted: string; publicKey: string } | null {
		this.ensureSchema();

		const row = this.ctx.storage.sql
			.exec("SELECT signer_key_encrypted, signer_key_public FROM pending_signer WHERE id = 1")
			.one() as { signer_key_encrypted: string; signer_key_public: string } | null;

		if (!row) return null;
		return { encrypted: row.signer_key_encrypted, publicKey: row.signer_key_public };
	}

	/** Clear the pending signer key after it's been moved to a FID DO. */
	clearPendingSignerKey(): void {
		this.ensureSchema();
		this.ctx.storage.sql.exec("DELETE FROM pending_signer");
	}

	/**
	 * Initialize sync for a new user with a pre-encrypted signer key.
	 * Called by the worker after retrieving the key from the pending DO.
	 */
	async setupWithEncryptedKey(params: {
		fid: number;
		did: string;
		pdsUrl: string;
		signerKeyEncrypted: string;
		signerKeyPublic: string;
	}): Promise<{ ok: true }> {
		this.ensureSchema();

		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO sync_config (fid, did, pds_url, signer_key_encrypted, signer_key_public)
			 VALUES (?, ?, ?, ?, ?)`,
			params.fid,
			params.did,
			params.pdsUrl,
			params.signerKeyEncrypted,
			params.signerKeyPublic,
		);

		return { ok: true };
	}

	/** Get the current sync configuration. */
	getConfig(): SyncConfig | null {
		this.ensureSchema();

		const row = this.ctx.storage.sql
			.exec("SELECT fid, did, pds_url, signer_key_public, enabled, created_at FROM sync_config LIMIT 1")
			.one() as { fid: number; did: string; pds_url: string; signer_key_public: string; enabled: number; created_at: string } | null;

		if (!row) return null;

		return {
			fid: row.fid,
			did: row.did,
			pdsUrl: row.pds_url,
			signerKeyPublic: row.signer_key_public,
			enabled: row.enabled === 1,
			createdAt: row.created_at,
		};
	}

	/** Enable sync. */
	enable(): void {
		this.ensureSchema();
		this.ctx.storage.sql.exec("UPDATE sync_config SET enabled = 1, updated_at = datetime('now')");
	}

	/** Disable sync. */
	disable(): void {
		this.ensureSchema();
		this.ctx.storage.sql.exec("UPDATE sync_config SET enabled = 0, updated_at = datetime('now')");
	}

	/** Get the decrypted signer private key. */
	async getSignerKey(): Promise<string | null> {
		this.ensureSchema();

		const row = this.ctx.storage.sql
			.exec("SELECT signer_key_encrypted FROM sync_config LIMIT 1")
			.one() as { signer_key_encrypted: string } | null;

		if (!row) return null;

		return decryptSignerKey(row.signer_key_encrypted, this.env.SIGNER_ENCRYPTION_KEY);
	}

	/** Store a sync mapping (ATProto rkey → Farcaster hash) for delete sync. */
	saveMapping(collection: string, rkey: string, farcasterHash: string): void {
		this.ensureSchema();
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO sync_mapping (collection, atproto_rkey, farcaster_hash)
			 VALUES (?, ?, ?)`,
			collection,
			rkey,
			farcasterHash,
		);
	}

	/** Look up a Farcaster hash by ATProto collection + rkey. */
	getMapping(collection: string, rkey: string): string | null {
		this.ensureSchema();
		const row = this.ctx.storage.sql
			.exec("SELECT farcaster_hash FROM sync_mapping WHERE collection = ? AND atproto_rkey = ?", collection, rkey)
			.one() as { farcaster_hash: string } | null;

		return row?.farcaster_hash ?? null;
	}

	/** Delete a sync mapping. */
	deleteMapping(collection: string, rkey: string): void {
		this.ensureSchema();
		this.ctx.storage.sql.exec(
			"DELETE FROM sync_mapping WHERE collection = ? AND atproto_rkey = ?",
			collection,
			rkey,
		);
	}

	/**
	 * Handle a sync request — transform an ATProto record into a Farcaster message
	 * and submit it to the Hub.
	 */
	async syncRecord(request: SyncRequest): Promise<{ ok: true; farcasterHash?: string }> {
		this.ensureSchema();

		const config = this.getConfig();
		if (!config) {
			throw new Error("Sync not configured for this account");
		}
		if (!config.enabled) {
			throw new Error("Sync is disabled for this account");
		}

		if (request.action === "create") {
			if (request.collection === "app.bsky.actor.profile") {
				return this.syncProfile(request, config);
			}
			console.log(`[sync] Unsupported collection for create: ${request.collection}`);
			return { ok: true };
		} else if (request.action === "delete") {
			if (request.collection === "app.bsky.actor.profile") {
				return this.deleteProfile(config);
			}
			const farcasterHash = this.getMapping(request.collection, request.rkey);
			if (!farcasterHash) {
				return { ok: true };
			}
			// TODO: Build remove message for other collections
			console.log(`[sync] Would delete Farcaster message ${farcasterHash} for ${request.collection}/${request.rkey}`);
			this.deleteMapping(request.collection, request.rkey);
			return { ok: true, farcasterHash };
		}

		throw new Error(`Unknown action: ${request.action}`);
	}

	/**
	 * Sync an app.bsky.actor.profile record to Farcaster UserData messages.
	 *
	 * Extracts displayName, description, and avatar from the ATProto record
	 * and submits UserDataAdd messages for each.
	 */
	private async syncProfile(
		request: SyncRequest,
		config: SyncConfig,
	): Promise<{ ok: true; farcasterHash?: string }> {
		const record = request.record;
		if (!record) {
			throw new Error("Profile sync requires a record");
		}

		const signerKey = await this.getSignerKey();
		if (!signerKey) {
			throw new Error("No signer key available");
		}

		const fields: Array<{ type: UserDataType; value: string }> = [];

		if (typeof record.displayName === "string") {
			fields.push({ type: USER_DATA_TYPE_DISPLAY, value: record.displayName });
		}

		if (typeof record.description === "string") {
			fields.push({ type: USER_DATA_TYPE_BIO, value: record.description });
		}

		// Avatar: ATProto stores blob refs, construct PDS blob URL
		const avatar = record.avatar as Record<string, unknown> | undefined;
		if (avatar?.ref && typeof avatar.ref === "object") {
			const ref = avatar.ref as Record<string, unknown>;
			const cid = ref.$link as string | undefined;
			if (cid) {
				const blobUrl = `${config.pdsUrl}/xrpc/com.atproto.sync.getBlob?did=${config.did}&cid=${cid}`;
				fields.push({ type: USER_DATA_TYPE_PFP, value: blobUrl });
			}
		}

		let lastHash: string | undefined;

		for (const field of fields) {
			const { messageBytes, hash } = buildUserDataMessage(
				config.fid,
				field.type,
				field.value,
				signerKey,
			);

			const result = await submitMessage(this.env.HUB_API_URL, messageBytes, hash);
			if (!result.ok) {
				console.error(`[sync] Hub rejected UserData type=${field.type}: ${result.errCode} ${result.message}`);
				continue;
			}

			lastHash = result.hash;
			console.log(`[sync] Submitted UserData type=${field.type} hash=${result.hash} for FID ${config.fid}`);
		}

		// Store mapping for the profile record
		if (lastHash) {
			this.saveMapping(request.collection, request.rkey, lastHash);
		}

		return { ok: true, farcasterHash: lastHash };
	}

	/**
	 * Handle profile deletion by sending empty UserData values.
	 * UserData is last-write-wins, so empty strings effectively clear the fields.
	 */
	private async deleteProfile(config: SyncConfig): Promise<{ ok: true; farcasterHash?: string }> {
		const signerKey = await this.getSignerKey();
		if (!signerKey) {
			throw new Error("No signer key available");
		}

		const types: UserDataType[] = [USER_DATA_TYPE_DISPLAY, USER_DATA_TYPE_BIO, USER_DATA_TYPE_PFP];
		let lastHash: string | undefined;

		for (const type of types) {
			const { messageBytes, hash } = buildUserDataMessage(
				config.fid,
				type,
				"", // empty string clears the field
				signerKey,
			);

			const result = await submitMessage(this.env.HUB_API_URL, messageBytes, hash);
			if (!result.ok) {
				console.error(`[sync] Hub rejected UserData clear type=${type}: ${result.errCode} ${result.message}`);
				continue;
			}
			lastHash = result.hash;
		}

		this.deleteMapping("app.bsky.actor.profile", "self");
		return { ok: true, farcasterHash: lastHash };
	}
}
