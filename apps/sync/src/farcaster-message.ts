/**
 * Farcaster message construction: MessageData encoding, BLAKE3 hashing, ed25519 signing.
 *
 * Builds UserDataAdd and CastAdd messages.
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
	encodeVarintField,
	encodeBytesField,
	encodeStringField,
	encodeEmptyField,
	concat,
} from "./protobuf";
import { hexToBytes } from "./crypto";
import {
	MESSAGE_TYPE_CAST_ADD,
	MESSAGE_TYPE_USER_DATA_ADD,
	HASH_SCHEME_BLAKE3,
	SIGNATURE_SCHEME_ED25519,
	FARCASTER_NETWORK_MAINNET,
	FARCASTER_EPOCH,
	type UserDataType,
} from "./types";

/**
 * Encode a UserDataBody submessage.
 * - field 1: type (varint)
 * - field 2: value (string)
 */
function encodeUserDataBody(type: UserDataType, value: string): Uint8Array {
	return concat([encodeVarintField(1, type), encodeStringField(2, value)]);
}

/**
 * Encode a UserDataAdd MessageData protobuf.
 * - field 1: type (varint) = MESSAGE_TYPE_USER_DATA_ADD
 * - field 2: fid (varint)
 * - field 3: timestamp (varint, seconds since Farcaster epoch)
 * - field 4: network (varint) = FARCASTER_NETWORK_MAINNET
 * - field 12: user_data_body (submessage)
 */
export function encodeMessageData(
	fid: number,
	userDataType: UserDataType,
	value: string,
	timestamp?: number,
): Uint8Array {
	const ts = timestamp ?? Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;
	const body = encodeUserDataBody(userDataType, value);

	return concat([
		encodeVarintField(1, MESSAGE_TYPE_USER_DATA_ADD),
		encodeVarintField(2, fid),
		encodeVarintField(3, ts),
		encodeVarintField(4, FARCASTER_NETWORK_MAINNET),
		encodeBytesField(12, body),
	]);
}

/**
 * Build a complete signed Farcaster Message protobuf.
 *
 * Message structure:
 * - field 2: hash (20-byte truncated BLAKE3)
 * - field 3: hash_scheme (varint) = HASH_SCHEME_BLAKE3
 * - field 4: signature (64-byte ed25519)
 * - field 5: signature_scheme (varint) = SIGNATURE_SCHEME_ED25519
 * - field 6: signer (32-byte ed25519 public key)
 * - field 7: data_bytes (raw serialized MessageData)
 *
 * Note: field 1 (parsed MessageData) is NOT set — Hub uses field 7 (raw bytes).
 */
export function buildSignedMessage(
	dataBytes: Uint8Array,
	signerPrivateKeyHex: string,
): { messageBytes: Uint8Array; hash: Uint8Array } {
	const privateKeyBytes = hexToBytes(signerPrivateKeyHex);

	// 1. Hash the data bytes (BLAKE3, truncated to 20 bytes)
	const hash = blake3(dataBytes, { dkLen: 20 });

	// 2. Sign the 20-byte hash
	const signature = ed25519.sign(hash, privateKeyBytes);

	// 3. Derive public key
	const publicKey = ed25519.getPublicKey(privateKeyBytes);

	// 4. Assemble the Message protobuf
	// field 1 = parsed MessageData (for Hub validation)
	// field 7 = raw MessageData bytes (for hash/sig verification)
	// Both contain the same data; the Hub requires both.
	const messageBytes = concat([
		encodeBytesField(1, dataBytes),
		encodeBytesField(2, hash),
		encodeVarintField(3, HASH_SCHEME_BLAKE3),
		encodeBytesField(4, signature),
		encodeVarintField(5, SIGNATURE_SCHEME_ED25519),
		encodeBytesField(6, publicKey),
		encodeBytesField(7, dataBytes),
	]);

	return { messageBytes, hash };
}

/**
 * Build a complete signed UserDataAdd message ready for Hub submission.
 */
export function buildUserDataMessage(
	fid: number,
	userDataType: UserDataType,
	value: string,
	signerPrivateKeyHex: string,
	timestamp?: number,
): { messageBytes: Uint8Array; hash: Uint8Array } {
	const dataBytes = encodeMessageData(fid, userDataType, value, timestamp);
	return buildSignedMessage(dataBytes, signerPrivateKeyHex);
}

// --- CastAdd ---

export interface CastAddOptions {
	parentFid?: number;
	parentHash?: string;
	timestamp?: number;
}

/**
 * Encode a CastId submessage.
 * - field 1: fid (varint)
 * - field 2: hash (bytes)
 */
function encodeCastId(fid: number, hashHex: string): Uint8Array {
	return concat([
		encodeVarintField(1, fid),
		encodeBytesField(2, hexToBytes(hashHex)),
	]);
}

/**
 * Encode a CastAddBody submessage.
 * Fields (matching hub-monorepo protobuf schema):
 * - field 1: embeds_deprecated (repeated string) — omitted
 * - field 2: mentions (packed repeated uint64) — always present, even if empty
 * - field 3: parent_cast_id (optional CastId submessage)
 * - field 4: text (string)
 * - field 5: mentions_positions (packed repeated uint32) — always present, even if empty
 * - field 6: embeds (repeated Embed) — omitted
 * - field 7: parent_url (optional string) — omitted
 * - field 8: type (varint, 0 = CAST — omitted since 0 is default)
 */
export function encodeCastAddBody(
	text: string,
	parentFid?: number,
	parentHash?: string,
): Uint8Array {
	const fields: Uint8Array[] = [];

	// field 2: mentions (empty packed repeated)
	fields.push(encodeEmptyField(2));

	if (parentFid !== undefined && parentHash !== undefined) {
		fields.push(encodeBytesField(3, encodeCastId(parentFid, parentHash)));
	}

	fields.push(encodeStringField(4, text));

	// field 5: mentions_positions (empty packed repeated)
	fields.push(encodeEmptyField(5));

	return concat(fields);
}

/**
 * Encode a CastAdd MessageData protobuf.
 * - field 1: type (varint) = MESSAGE_TYPE_CAST_ADD (3)
 * - field 2: fid (varint)
 * - field 3: timestamp (varint, seconds since Farcaster epoch)
 * - field 4: network (varint) = FARCASTER_NETWORK_MAINNET
 * - field 5: cast_add_body (submessage)
 */
export function encodeCastMessageData(
	fid: number,
	text: string,
	options?: CastAddOptions,
): Uint8Array {
	const ts =
		options?.timestamp ?? Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;
	const body = encodeCastAddBody(text, options?.parentFid, options?.parentHash);

	return concat([
		encodeVarintField(1, MESSAGE_TYPE_CAST_ADD),
		encodeVarintField(2, fid),
		encodeVarintField(3, ts),
		encodeVarintField(4, FARCASTER_NETWORK_MAINNET),
		encodeBytesField(5, body),
	]);
}

/**
 * Build a complete signed CastAdd message ready for Hub submission.
 */
export function buildCastMessage(
	fid: number,
	text: string,
	signerPrivateKeyHex: string,
	options?: CastAddOptions,
): { messageBytes: Uint8Array; hash: Uint8Array } {
	const dataBytes = encodeCastMessageData(fid, text, options);
	return buildSignedMessage(dataBytes, signerPrivateKeyHex);
}
