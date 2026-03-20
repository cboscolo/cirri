/** Sync configuration stored in the DO */
export interface SyncConfig {
	fid: number;
	did: string;
	pdsUrl: string;
	signerKeyPublic: string;
	enabled: boolean;
	createdAt: string;
}

/** Payload for POST /sync — sent by the agent after writing to PDS */
export interface SyncRequest {
	fid: number;
	did: string;
	action: "create" | "delete";
	collection: string;
	rkey: string;
	record?: Record<string, unknown>;
}

/** Payload for POST /generate-signer — generates a keypair, stores encrypted privkey */
export interface GenerateSignerRequest {
	address: string;
}

/** Payload for POST /setup — sent by signup service during account creation */
export interface SetupRequest {
	fid: number;
	did: string;
	pdsUrl: string;
	/** Ethereum address used during /generate-signer — used to retrieve the pending key */
	address: string;
	signerPublicKey: string;
}

/** Sync mapping row (ATProto rkey → Farcaster hash) */
export interface SyncMapping {
	atprotoRkey: string;
	collection: string;
	farcasterHash: string;
	createdAt: string;
}

import type { SyncDurableObject } from "./sync-do";

export interface Env {
	SYNC_DO: DurableObjectNamespace<SyncDurableObject>;
	HUB_API_URL: string;
	PDS_DOMAIN: string;
	SIGNER_ENCRYPTION_KEY: string;
	INTERNAL_API_KEY: string;
	JWT_SECRET: string;
}
