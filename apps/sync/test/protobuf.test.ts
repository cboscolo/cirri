import { describe, it, expect } from "vitest";
import {
	encodeVarint,
	encodeVarintField,
	encodeBytesField,
	encodeStringField,
	concat,
} from "../src/protobuf";

describe("protobuf encoder", () => {
	describe("encodeVarint", () => {
		it("encodes single-byte values", () => {
			expect(encodeVarint(0)).toEqual(new Uint8Array([0x00]));
			expect(encodeVarint(1)).toEqual(new Uint8Array([0x01]));
			expect(encodeVarint(127)).toEqual(new Uint8Array([0x7f]));
		});

		it("encodes multi-byte values", () => {
			// 128 = 0x80 → varint: [0x80, 0x01]
			expect(encodeVarint(128)).toEqual(new Uint8Array([0x80, 0x01]));
			// 300 = 0x12c → varint: [0xac, 0x02]
			expect(encodeVarint(300)).toEqual(new Uint8Array([0xac, 0x02]));
			// 16384 → varint: [0x80, 0x80, 0x01]
			expect(encodeVarint(16384)).toEqual(new Uint8Array([0x80, 0x80, 0x01]));
		});
	});

	describe("encodeVarintField", () => {
		it("encodes field 1 with value 11 (MessageType USER_DATA_ADD)", () => {
			// field 1, wire type 0 → tag = (1 << 3) | 0 = 0x08
			// value 11 → varint [0x0b]
			expect(encodeVarintField(1, 11)).toEqual(new Uint8Array([0x08, 0x0b]));
		});

		it("encodes field 2 with a larger value", () => {
			// field 2, wire type 0 → tag = (2 << 3) | 0 = 0x10
			// value 12345 → varint [0xb9, 0x60]
			const result = encodeVarintField(2, 12345);
			expect(result[0]).toBe(0x10); // tag
			expect(result[1]).toBe(0xb9); // first varint byte
			expect(result[2]).toBe(0x60); // second varint byte
		});
	});

	describe("encodeBytesField", () => {
		it("encodes a bytes field with length prefix", () => {
			const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
			// field 1, wire type 2 → tag = (1 << 3) | 2 = 0x0a
			// length = 3 → varint [0x03]
			const result = encodeBytesField(1, data);
			expect(result).toEqual(new Uint8Array([0x0a, 0x03, 0xaa, 0xbb, 0xcc]));
		});

		it("encodes an empty bytes field", () => {
			const result = encodeBytesField(1, new Uint8Array([]));
			expect(result).toEqual(new Uint8Array([0x0a, 0x00]));
		});
	});

	describe("encodeStringField", () => {
		it("encodes a UTF-8 string as length-delimited", () => {
			// field 2, wire type 2 → tag = (2 << 3) | 2 = 0x12
			// "hi" = [0x68, 0x69], length = 2
			const result = encodeStringField(2, "hi");
			expect(result).toEqual(new Uint8Array([0x12, 0x02, 0x68, 0x69]));
		});

		it("encodes an empty string", () => {
			const result = encodeStringField(1, "");
			expect(result).toEqual(new Uint8Array([0x0a, 0x00]));
		});
	});

	describe("concat", () => {
		it("concatenates multiple arrays", () => {
			const result = concat([
				new Uint8Array([1, 2]),
				new Uint8Array([3]),
				new Uint8Array([4, 5, 6]),
			]);
			expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
		});

		it("handles empty arrays", () => {
			const result = concat([new Uint8Array([]), new Uint8Array([1])]);
			expect(result).toEqual(new Uint8Array([1]));
		});
	});
});
