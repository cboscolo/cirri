/**
 * AES-256-GCM encryption/decryption for ed25519 signer private keys.
 *
 * The encryption key is a hex-encoded 32-byte symmetric key stored
 * as the SIGNER_ENCRYPTION_KEY env secret.
 *
 * Storage format: 12-byte IV || ciphertext || 16-byte auth tag
 */

import { ed25519 } from "@noble/curves/ed25519.js";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Generate an ed25519 keypair. Returns hex strings. */
export function generateEd25519Keypair(): {
	privateKey: string;
	publicKey: string;
} {
	const privateKeyBytes = ed25519.utils.randomSecretKey();
	const publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
	return {
		privateKey: bytesToHex(privateKeyBytes),
		publicKey: bytesToHex(publicKeyBytes),
	};
}

async function importKey(hexKey: string): Promise<CryptoKey> {
	const keyBytes = hexToBytes(hexKey);
	if (keyBytes.length !== 32) {
		throw new Error(`SIGNER_ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${keyBytes.length}`);
	}
	return crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

/**
 * Encrypt an ed25519 private key with AES-256-GCM.
 * Returns a hex string of: IV || ciphertext || tag
 */
export async function encryptSignerKey(
	privateKeyHex: string,
	encryptionKeyHex: string,
): Promise<string> {
	const key = await importKey(encryptionKeyHex);
	const plaintext = hexToBytes(privateKeyHex);
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
		key,
		plaintext.buffer as ArrayBuffer,
	);

	// WebCrypto appends the tag to the ciphertext
	const encryptedBytes = new Uint8Array(encrypted);
	const result = new Uint8Array(IV_LENGTH + encryptedBytes.length);
	result.set(iv, 0);
	result.set(encryptedBytes, IV_LENGTH);

	return bytesToHex(result);
}

/**
 * Decrypt an ed25519 private key from AES-256-GCM.
 * Input is hex string of: IV || ciphertext || tag
 * Returns the private key as a hex string.
 */
export async function decryptSignerKey(
	encryptedHex: string,
	encryptionKeyHex: string,
): Promise<string> {
	const key = await importKey(encryptionKeyHex);
	const data = hexToBytes(encryptedHex);

	const iv = data.slice(0, IV_LENGTH);
	const ciphertextWithTag = data.slice(IV_LENGTH);

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
		key,
		ciphertextWithTag,
	);

	return bytesToHex(new Uint8Array(decrypted));
}
