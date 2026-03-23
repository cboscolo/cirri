import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { submitMessage } from "../src/hub-client";

describe("hub-client", () => {
	const HUB_URL = "https://hub.example.com/v1";
	const testMessage = new Uint8Array([0x01, 0x02, 0x03]);
	const testHash = new Uint8Array(20).fill(0xab);

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends POST with correct URL and headers", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));

		await submitMessage(HUB_URL, testMessage, testHash);

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, init] = mockFetch.mock.calls[0]!;
		expect(url).toBe("https://hub.example.com/v1/submitMessage");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({ "Content-Type": "application/octet-stream" });
		expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(testMessage);
	});

	it("returns ok with hash on success", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

		const result = await submitMessage(HUB_URL, testMessage, testHash);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.hash).toBe("abababababababababababababababababababab"); // 20 bytes of 0xab = 40 hex chars
		}
	});

	it("returns error on HTTP failure with JSON body", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ errCode: "bad_request.validation_failure", message: "invalid message" }), {
				status: 400,
			}),
		);

		const result = await submitMessage(HUB_URL, testMessage, testHash);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errCode).toBe("bad_request.validation_failure");
			expect(result.message).toBe("invalid message");
		}
	});

	it("handles non-JSON error response", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
		);

		const result = await submitMessage(HUB_URL, testMessage, testHash);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errCode).toBe("HTTP_500");
			expect(result.message).toBe("Internal Server Error");
		}
	});
});
