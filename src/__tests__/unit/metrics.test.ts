import { describe, test, expect } from "bun:test";
import { createMcpMetrics } from "../../metrics.js";

describe("McpMetrics", () => {
	describe("session tracking", () => {
		test("tracks session creation", () => {
			const m = createMcpMetrics();
			m.sessionCreated();
			m.sessionCreated();
			const snap = m.snapshot();
			expect(snap.activeSessions).toBe(2);
			expect(snap.totalSessionsCreated).toBe(2);
		});

		test("tracks session closure", () => {
			const m = createMcpMetrics();
			m.sessionCreated();
			m.sessionCreated();
			m.sessionClosed();
			const snap = m.snapshot();
			expect(snap.activeSessions).toBe(1);
			expect(snap.totalSessionsClosed).toBe(1);
		});

		test("activeSessions does not go below zero", () => {
			const m = createMcpMetrics();
			m.sessionClosed();
			const snap = m.snapshot();
			expect(snap.activeSessions).toBe(0);
			expect(snap.totalSessionsClosed).toBe(1);
		});
	});

	describe("tool call tracking", () => {
		test("tracks total tool calls", () => {
			const m = createMcpMetrics();
			m.toolCallRecorded(50);
			m.toolCallRecorded(100);
			m.toolCallRecorded(150);
			const snap = m.snapshot();
			expect(snap.totalToolCalls).toBe(3);
		});

		test("calculates average duration", () => {
			const m = createMcpMetrics();
			m.toolCallRecorded(100);
			m.toolCallRecorded(200);
			m.toolCallRecorded(300);
			const snap = m.snapshot();
			expect(snap.avgToolCallDurationMs).toBe(200);
		});

		test("calculates p95 duration", () => {
			const m = createMcpMetrics();
			for (let i = 1; i <= 100; i++) {
				m.toolCallRecorded(i);
			}
			const snap = m.snapshot();
			expect(snap.p95ToolCallDurationMs).toBe(95);
		});

		test("returns 0 for avg and p95 when no calls recorded", () => {
			const m = createMcpMetrics();
			const snap = m.snapshot();
			expect(snap.avgToolCallDurationMs).toBe(0);
			expect(snap.p95ToolCallDurationMs).toBe(0);
			expect(snap.totalToolCalls).toBe(0);
		});
	});

	describe("rate limit hits", () => {
		test("tracks rate limit hits", () => {
			const m = createMcpMetrics();
			m.rateLimitHit();
			m.rateLimitHit();
			m.rateLimitHit();
			expect(m.snapshot().totalRateLimitHits).toBe(3);
		});
	});

	describe("circuit breaker trips", () => {
		test("tracks circuit breaker trips", () => {
			const m = createMcpMetrics();
			m.circuitBreakerTripped("org-1");
			m.circuitBreakerTripped("org-2");
			expect(m.snapshot().totalCircuitBreakerTrips).toBe(2);
		});
	});

	describe("auth failures", () => {
		test("tracks auth failures", () => {
			const m = createMcpMetrics();
			m.authFailure();
			m.authFailure();
			expect(m.snapshot().totalAuthFailures).toBe(2);
		});
	});

	describe("snapshot", () => {
		test("returns complete snapshot with all fields", () => {
			const m = createMcpMetrics();
			m.sessionCreated();
			m.toolCallRecorded(50);
			m.rateLimitHit();
			m.circuitBreakerTripped("org-1");
			m.authFailure();

			const snap = m.snapshot();
			expect(snap).toEqual({
				activeSessions: 1,
				totalSessionsCreated: 1,
				totalSessionsClosed: 0,
				totalToolCalls: 1,
				totalRateLimitHits: 1,
				totalCircuitBreakerTrips: 1,
				totalAuthFailures: 1,
				avgToolCallDurationMs: 50,
				p95ToolCallDurationMs: 50,
			});
		});

		test("returns fresh snapshot on each call", () => {
			const m = createMcpMetrics();
			m.sessionCreated();
			const snap1 = m.snapshot();
			m.sessionCreated();
			const snap2 = m.snapshot();
			expect(snap1.activeSessions).toBe(1);
			expect(snap2.activeSessions).toBe(2);
		});
	});

	describe("duration sample cap", () => {
		test("caps duration samples at 1000", () => {
			const m = createMcpMetrics();
			for (let i = 0; i < 1100; i++) {
				m.toolCallRecorded(i);
			}
			const snap = m.snapshot();
			expect(snap.totalToolCalls).toBe(1100);
			expect(snap.avgToolCallDurationMs).toBeGreaterThan(0);
		});
	});
});
