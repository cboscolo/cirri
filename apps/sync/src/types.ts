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

/** Farcaster protocol constants */
export const FARCASTER_EPOCH = 1609459200; // 2021-01-01T00:00:00Z

export const MESSAGE_TYPE_CAST_ADD = 1;
export const MESSAGE_TYPE_USER_DATA_ADD = 11;

export const HASH_SCHEME_BLAKE3 = 1;
export const SIGNATURE_SCHEME_ED25519 = 1;
export const FARCASTER_NETWORK_MAINNET = 1;

/** Farcaster UserData field types */
export const USER_DATA_TYPE_PFP = 1 as const;
export const USER_DATA_TYPE_DISPLAY = 2 as const;
export const USER_DATA_TYPE_BIO = 3 as const;
export const USER_DATA_TYPE_URL = 5 as const;
export const USER_DATA_TYPE_USERNAME = 6 as const;

export type UserDataType =
	| typeof USER_DATA_TYPE_PFP
	| typeof USER_DATA_TYPE_DISPLAY
	| typeof USER_DATA_TYPE_BIO
	| typeof USER_DATA_TYPE_URL
	| typeof USER_DATA_TYPE_USERNAME;

import type { SyncDurableObject } from "./sync-do";

export interface Env {
	SYNC_DO: DurableObjectNamespace<SyncDurableObject>;
	HUB_API_URL: string;
	PDS_DOMAIN: string;
	SIGNER_ENCRYPTION_KEY: string;
	INTERNAL_API_KEY: string;
	JWT_SECRET: string;
}
