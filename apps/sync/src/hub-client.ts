/**
 * HTTP client for Farcaster Hub API.
 *
 * Submits signed protobuf messages via POST /v1/submitMessage.
 */

import { bytesToHex } from "./crypto";

export interface HubSubmitResult {
	ok: true;
	hash: string;
}

export interface HubSubmitError {
	ok: false;
	errCode: string;
	message: string;
}

/**
 * Submit a signed Farcaster message to the Hub.
 *
 * @param hubApiUrl - Base URL of the Hub HTTP API (e.g. "https://hub.example.com/v1")
 * @param messageBytes - Raw protobuf bytes of the signed Message
 * @param messageHash - The 20-byte BLAKE3 hash for logging/return
 */
export async function submitMessage(
	hubApiUrl: string,
	messageBytes: Uint8Array,
	messageHash: Uint8Array,
): Promise<HubSubmitResult | HubSubmitError> {
	const url = `${hubApiUrl}/submitMessage`;

	// Use .slice() to ensure we send exactly the message bytes
	// (Uint8Array.buffer can be larger if the array is a view)
	const body = messageBytes.buffer.byteLength === messageBytes.byteLength
		? messageBytes.buffer
		: messageBytes.slice().buffer;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: body as ArrayBuffer,
	});

	if (!response.ok) {
		const text = await response.text();
		let errCode = `HTTP_${response.status}`;
		let message = response.statusText;
		try {
			const respBody = JSON.parse(text) as Record<string, unknown>;
			errCode = (respBody.errCode as string) ?? errCode;
			message = (respBody.message as string) ?? message;
		} catch {
			// Not JSON — use raw text as message
			if (text) message = text;
		}
		return { ok: false, errCode, message };
	}

	return {
		ok: true,
		hash: bytesToHex(messageHash),
	};
}
