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
import { encryptSignerKey, decryptSignerKey } from "./crypto";
import type { Env, SyncConfig, SyncRequest, SetupRequest } from "./types";

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
	 *
	 * This is the core sync logic. Currently a stub — will be implemented in step 4/5.
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
			// TODO (step 4-5): Transform ATProto record → Farcaster message, sign, submit to Hub
			// For now, log and return success
			console.log(`[sync] Would sync ${request.collection}/${request.rkey} for FID ${request.fid}`);
			return { ok: true };
		} else if (request.action === "delete") {
			const farcasterHash = this.getMapping(request.collection, request.rkey);
			if (!farcasterHash) {
				// No mapping — nothing to delete on Farcaster side
				return { ok: true };
			}
			// TODO (step 7): Build remove message, sign, submit to Hub
			console.log(`[sync] Would delete Farcaster message ${farcasterHash} for ${request.collection}/${request.rkey}`);
			this.deleteMapping(request.collection, request.rkey);
			return { ok: true, farcasterHash };
		}

		throw new Error(`Unknown action: ${request.action}`);
	}
}
