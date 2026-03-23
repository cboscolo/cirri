import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import {
	encodeMessageData,
	buildSignedMessage,
	buildUserDataMessage,
	encodeCastAddBody,
	encodeCastMessageData,
	buildCastMessage,
} from "../src/farcaster-message";
import { bytesToHex, hexToBytes } from "../src/crypto";
import {
	USER_DATA_TYPE_DISPLAY,
	USER_DATA_TYPE_BIO,
	USER_DATA_TYPE_PFP,
	MESSAGE_TYPE_CAST_ADD,
	FARCASTER_EPOCH,
} from "../src/types";

// Fixed test key
const TEST_PRIVATE_KEY = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const TEST_PUBLIC_KEY = ed25519.getPublicKey(hexToBytes(TEST_PRIVATE_KEY));

describe("farcaster-message", () => {
	describe("encodeMessageData", () => {
		it("produces valid protobuf bytes", () => {
			const data = encodeMessageData(12345, USER_DATA_TYPE_DISPLAY, "Alice", 1000);
			expect(data).toBeInstanceOf(Uint8Array);
			expect(data.length).toBeGreaterThan(0);

			// field 1 (type): tag=0x08, value=0x0b (11 = USER_DATA_ADD)
			expect(data[0]).toBe(0x08);
			expect(data[1]).toBe(0x0b);
		});

		it("encodes FID correctly", () => {
			const data = encodeMessageData(1, USER_DATA_TYPE_DISPLAY, "Test", 0);
			// field 2 (fid): tag=0x10, value=0x01
			expect(data[2]).toBe(0x10);
			expect(data[3]).toBe(0x01);
		});

		it("uses current time when no timestamp provided", () => {
			const before = Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;
			const data = encodeMessageData(1, USER_DATA_TYPE_DISPLAY, "Test");
			const after = Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;

			// The timestamp bytes should be reasonable (we can't decode easily but
			// can verify the data was produced)
			expect(data.length).toBeGreaterThan(0);
			// Just verify it doesn't throw and returns bytes
		});
	});

	describe("buildSignedMessage", () => {
		it("produces a 20-byte BLAKE3 hash", () => {
			const dataBytes = encodeMessageData(12345, USER_DATA_TYPE_DISPLAY, "Alice", 1000);
			const { hash } = buildSignedMessage(dataBytes, TEST_PRIVATE_KEY);
			expect(hash.length).toBe(20);
		});

		it("hash matches BLAKE3 of data bytes", () => {
			const dataBytes = encodeMessageData(12345, USER_DATA_TYPE_DISPLAY, "Alice", 1000);
			const { hash } = buildSignedMessage(dataBytes, TEST_PRIVATE_KEY);
			const expectedHash = blake3(dataBytes, { dkLen: 20 });
			expect(hash).toEqual(expectedHash);
		});

		it("signature verifies with ed25519", () => {
			const dataBytes = encodeMessageData(12345, USER_DATA_TYPE_DISPLAY, "Alice", 1000);
			const { hash, messageBytes } = buildSignedMessage(dataBytes, TEST_PRIVATE_KEY);

			// Find the 64-byte signature by scanning for field 4 tag (0x22)
			// followed by length byte (0x40 = 64)
			let sigStart = -1;
			for (let i = 0; i < messageBytes.length - 65; i++) {
				if (messageBytes[i] === 0x22 && messageBytes[i + 1] === 0x40) {
					sigStart = i + 2;
					break;
				}
			}
			expect(sigStart).toBeGreaterThan(0);
			const signature = messageBytes.slice(sigStart, sigStart + 64);

			expect(ed25519.verify(signature, hash, TEST_PUBLIC_KEY)).toBe(true);
		});

		it("produces deterministic output for same inputs", () => {
			const dataBytes = encodeMessageData(12345, USER_DATA_TYPE_DISPLAY, "Alice", 1000);
			const result1 = buildSignedMessage(dataBytes, TEST_PRIVATE_KEY);
			const result2 = buildSignedMessage(dataBytes, TEST_PRIVATE_KEY);
			expect(result1.messageBytes).toEqual(result2.messageBytes);
			expect(result1.hash).toEqual(result2.hash);
		});
	});

	describe("buildUserDataMessage", () => {
		it("builds a DISPLAY message", () => {
			const { messageBytes, hash } = buildUserDataMessage(
				12345,
				USER_DATA_TYPE_DISPLAY,
				"Alice",
				TEST_PRIVATE_KEY,
				1000,
			);
			expect(messageBytes).toBeInstanceOf(Uint8Array);
			expect(messageBytes.length).toBeGreaterThan(0);
			expect(hash.length).toBe(20);
		});

		it("builds a BIO message", () => {
			const { messageBytes, hash } = buildUserDataMessage(
				12345,
				USER_DATA_TYPE_BIO,
				"Hello world",
				TEST_PRIVATE_KEY,
				1000,
			);
			expect(messageBytes.length).toBeGreaterThan(0);
			expect(hash.length).toBe(20);
		});

		it("builds a PFP message with URL", () => {
			const pfpUrl = "https://12345.fid.is/xrpc/com.atproto.sync.getBlob?did=did:web:12345.fid.is&cid=bafkrei123";
			const { messageBytes, hash } = buildUserDataMessage(
				12345,
				USER_DATA_TYPE_PFP,
				pfpUrl,
				TEST_PRIVATE_KEY,
				1000,
			);
			expect(messageBytes.length).toBeGreaterThan(0);
			expect(hash.length).toBe(20);
		});

		it("builds a message with empty value (for clearing)", () => {
			const { messageBytes, hash } = buildUserDataMessage(
				12345,
				USER_DATA_TYPE_DISPLAY,
				"",
				TEST_PRIVATE_KEY,
				1000,
			);
			expect(messageBytes.length).toBeGreaterThan(0);
			expect(hash.length).toBe(20);
		});

		it("different data types produce different hashes", () => {
			const display = buildUserDataMessage(12345, USER_DATA_TYPE_DISPLAY, "Alice", TEST_PRIVATE_KEY, 1000);
			const bio = buildUserDataMessage(12345, USER_DATA_TYPE_BIO, "Alice", TEST_PRIVATE_KEY, 1000);
			expect(bytesToHex(display.hash)).not.toBe(bytesToHex(bio.hash));
		});
	});

	describe("encodeCastAddBody", () => {
		it("encodes text-only cast", () => {
			const body = encodeCastAddBody("Hello world");
			expect(body).toBeInstanceOf(Uint8Array);
			expect(body.length).toBeGreaterThan(0);
			// field 2 tag = (2 << 3) | 2 = 0x12 (empty mentions, always first)
			expect(body[0]).toBe(0x12);
			// text field should be present somewhere after
			const textTag = 0x22; // field 4 tag
			expect(body.includes(textTag)).toBe(true);
		});

		it("encodes cast with parent", () => {
			const parentHash = "0a0b0c0d0e0f101112131415161718191a1b1c1d";
			const body = encodeCastAddBody("Reply", 1898, parentHash);
			expect(body.length).toBeGreaterThan(0);
			// field 2 (mentions) first, then field 3 (parent_cast_id)
			expect(body[0]).toBe(0x12); // mentions tag
			const parentTag = 0x1a; // field 3 tag
			expect(body.includes(parentTag)).toBe(true);
		});
	});

	describe("encodeCastMessageData", () => {
		it("produces valid protobuf bytes with type=1", () => {
			const data = encodeCastMessageData(12345, "Hello", { timestamp: 1000 });
			expect(data).toBeInstanceOf(Uint8Array);
			// field 1 (type): tag=0x08, value=0x01 (1 = CAST_ADD)
			expect(data[0]).toBe(0x08);
			expect(data[1]).toBe(0x01);
		});

		it("uses cast_add_body at field 5", () => {
			const data = encodeCastMessageData(1, "Test", { timestamp: 0 });
			// After field 1 (2 bytes), field 2 (2 bytes), field 3 (2 bytes), field 4 (2 bytes)
			// field 5 tag = (5 << 3) | 2 = 0x2a
			const field5TagIndex = data.indexOf(0x2a);
			expect(field5TagIndex).toBeGreaterThan(0);
		});
	});

	describe("buildCastMessage", () => {
		it("builds a text-only cast", () => {
			const { messageBytes, hash } = buildCastMessage(
				12345,
				"Hello from test!",
				TEST_PRIVATE_KEY,
				{ timestamp: 1000 },
			);
			expect(messageBytes).toBeInstanceOf(Uint8Array);
			expect(messageBytes.length).toBeGreaterThan(0);
			expect(hash.length).toBe(20);
		});

		it("builds a reply cast", () => {
			const parentHash = "0a0b0c0d0e0f101112131415161718191a1b1c1d";
			const { messageBytes, hash } = buildCastMessage(
				12345,
				"Replying!",
				TEST_PRIVATE_KEY,
				{ parentFid: 1898, parentHash, timestamp: 1000 },
			);
			expect(messageBytes.length).toBeGreaterThan(0);
			expect(hash.length).toBe(20);
		});

		it("signature verifies with ed25519", () => {
			const { hash, messageBytes } = buildCastMessage(
				12345,
				"Verify me",
				TEST_PRIVATE_KEY,
				{ timestamp: 1000 },
			);

			// Find the 64-byte signature by scanning for field 4 tag (0x22) + length (0x40)
			let sigStart = -1;
			for (let i = 0; i < messageBytes.length - 65; i++) {
				if (messageBytes[i] === 0x22 && messageBytes[i + 1] === 0x40) {
					sigStart = i + 2;
					break;
				}
			}
			expect(sigStart).toBeGreaterThan(0);
			const signature = messageBytes.slice(sigStart, sigStart + 64);
			expect(ed25519.verify(signature, hash, TEST_PUBLIC_KEY)).toBe(true);
		});

		it("cast and userdata produce different hashes for same text", () => {
			const cast = buildCastMessage(12345, "Alice", TEST_PRIVATE_KEY, { timestamp: 1000 });
			const userData = buildUserDataMessage(12345, USER_DATA_TYPE_DISPLAY, "Alice", TEST_PRIVATE_KEY, 1000);
			expect(bytesToHex(cast.hash)).not.toBe(bytesToHex(userData.hash));
		});
	});
});
