/**
 * Minimal protobuf wire-format encoder.
 *
 * Only two wire types needed for Farcaster messages:
 * - Varint (wire type 0): enums, integers
 * - Length-delimited (wire type 2): bytes, strings, submessages
 *
 * No external dependencies. Deterministic output.
 */

/** Encode an unsigned integer as a varint (LEB128). */
export function encodeVarint(value: number): Uint8Array {
	const bytes: number[] = [];
	let v = value >>> 0; // ensure unsigned 32-bit
	while (v > 0x7f) {
		bytes.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	bytes.push(v & 0x7f);
	return new Uint8Array(bytes);
}

/** Encode a varint field (wire type 0). */
export function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
	const tag = encodeVarint((fieldNumber << 3) | 0);
	const val = encodeVarint(value);
	return concat([tag, val]);
}

/** Encode a length-delimited field (wire type 2) with raw bytes. */
export function encodeBytesField(fieldNumber: number, data: Uint8Array): Uint8Array {
	const tag = encodeVarint((fieldNumber << 3) | 2);
	const len = encodeVarint(data.length);
	return concat([tag, len, data]);
}

/** Encode a length-delimited field (wire type 2) with a UTF-8 string. */
export function encodeStringField(fieldNumber: number, value: string): Uint8Array {
	const data = new TextEncoder().encode(value);
	return encodeBytesField(fieldNumber, data);
}

/** Encode an empty length-delimited field (wire type 2, length 0). Used for empty packed repeated fields. */
export function encodeEmptyField(fieldNumber: number): Uint8Array {
	const tag = encodeVarint((fieldNumber << 3) | 2);
	return concat([tag, new Uint8Array([0])]);
}

/** Concatenate multiple Uint8Arrays. */
export function concat(arrays: Uint8Array[]): Uint8Array {
	let totalLength = 0;
	for (const arr of arrays) {
		totalLength += arr.length;
	}
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}
