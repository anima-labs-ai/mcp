import { describe, test, expect } from "bun:test";
import { createMcpRateLimiter } from "../../mcp-rate-limiter.js";

describe("McpRateLimiter", () => {
	describe("checkToolCall", () => {
		test("allows calls within per-minute limit", () => {
			const limiter = createMcpRateLimiter({ toolCallsPerMinute: 3, toolCallsPerHour: 100 });
			expect(limiter.checkToolCall("key-1").allowed).toBe(true);
			expect(limiter.checkToolCall("key-1").allowed).toBe(true);
			expect(limiter.checkToolCall("key-1").allowed).toBe(true);
		});

		test("blocks calls exceeding per-minute limit", () => {
			const limiter = createMcpRateLimiter({ toolCallsPerMinute: 2, toolCallsPerHour: 100 });
			limiter.checkToolCall("key-1");
			limiter.checkToolCall("key-1");
			const result = limiter.checkToolCall("key-1");
			expect(result.allowed).toBe(false);
			expect(result.remaining).toBe(0);
			expect(result.retryAfterMs).toBeDefined();
			expect(result.retryAfterMs ?? 0).toBeGreaterThan(0);
		});

		test("blocks calls exceeding per-hour limit", () => {
			const limiter = createMcpRateLimiter({ toolCallsPerMinute: 100, toolCallsPerHour: 2 });
			limiter.checkToolCall("key-1");
			limiter.checkToolCall("key-1");
			const result = limiter.checkToolCall("key-1");
			expect(result.allowed).toBe(false);
		});

		test("tracks keys independently", () => {
			const limiter = createMcpRateLimiter({ toolCallsPerMinute: 1, toolCallsPerHour: 100 });
			expect(limiter.checkToolCall("key-1").allowed).toBe(true);
			expect(limiter.checkToolCall("key-2").allowed).toBe(true);
			expect(limiter.checkToolCall("key-1").allowed).toBe(false);
			expect(limiter.checkToolCall("key-2").allowed).toBe(false);
		});

		test("returns correct remaining count from tighter window", () => {
			const limiter = createMcpRateLimiter({ toolCallsPerMinute: 5, toolCallsPerHour: 100 });
			const r1 = limiter.checkToolCall("key-1");
			expect(r1.remaining).toBe(99);
			expect(r1.limit).toBe(100);

			limiter.checkToolCall("key-1");
			const r3 = limiter.checkToolCall("key-1");
			expect(r3.remaining).toBe(97);
		});
	});

	describe("checkSessionCreation", () => {
		test("allows when under session limit", () => {
			const limiter = createMcpRateLimiter({ sessionsPerKey: 5 });
			const result = limiter.checkSessionCreation("key-1", 3);
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(2);
		});

		test("blocks when at session limit", () => {
			const limiter = createMcpRateLimiter({ sessionsPerKey: 5 });
			const result = limiter.checkSessionCreation("key-1", 5);
			expect(result.allowed).toBe(false);
			expect(result.remaining).toBe(0);
		});

		test("blocks when over session limit", () => {
			const limiter = createMcpRateLimiter({ sessionsPerKey: 2 });
			const result = limiter.checkSessionCreation("key-1", 10);
			expect(result.allowed).toBe(false);
		});
	});

	describe("checkRequest", () => {
		test("allows requests within per-minute limit", () => {
			const limiter = createMcpRateLimiter({ requestsPerMinute: 3 });
			expect(limiter.checkRequest("key-1").allowed).toBe(true);
			expect(limiter.checkRequest("key-1").allowed).toBe(true);
			expect(limiter.checkRequest("key-1").allowed).toBe(true);
		});

		test("blocks requests exceeding per-minute limit", () => {
			const limiter = createMcpRateLimiter({ requestsPerMinute: 2 });
			limiter.checkRequest("key-1");
			limiter.checkRequest("key-1");
			const result = limiter.checkRequest("key-1");
			expect(result.allowed).toBe(false);
			expect(result.retryAfterMs).toBeDefined();
		});
	});

	describe("reset", () => {
		test("clears rate limit state for a key", () => {
			const limiter = createMcpRateLimiter({ toolCallsPerMinute: 1, toolCallsPerHour: 100 });
			limiter.checkToolCall("key-1");
			expect(limiter.checkToolCall("key-1").allowed).toBe(false);

			limiter.reset("key-1");
			expect(limiter.checkToolCall("key-1").allowed).toBe(true);
		});

		test("reset does not affect other keys", () => {
			const limiter = createMcpRateLimiter({ toolCallsPerMinute: 1, toolCallsPerHour: 100 });
			limiter.checkToolCall("key-1");
			limiter.checkToolCall("key-2");

			limiter.reset("key-1");
			expect(limiter.checkToolCall("key-1").allowed).toBe(true);
			expect(limiter.checkToolCall("key-2").allowed).toBe(false);
		});
	});

	describe("default limits", () => {
		test("uses default values when no options provided", () => {
			const limiter = createMcpRateLimiter();
			const result = limiter.checkToolCall("key-1");
			expect(result.allowed).toBe(true);
			expect(result.limit).toBe(3000);
			expect(result.remaining).toBe(2999);
		});
	});
});
