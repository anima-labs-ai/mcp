import { describe, test, expect } from "bun:test";
import { createCircuitBreaker, CircuitOpenError } from "../../circuit-breaker.js";

describe("CircuitBreaker", () => {
	describe("closed state", () => {
		test("executes function in closed state", async () => {
			const cb = createCircuitBreaker();
			const result = await cb.execute("org-1", async () => "ok");
			expect(result).toBe("ok");
		});

		test("starts in closed state", () => {
			const cb = createCircuitBreaker();
			expect(cb.getState("org-1")).toBe("closed");
		});

		test("propagates errors without opening circuit below threshold", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 5, volumeThreshold: 10 });
			for (let i = 0; i < 3; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}
			expect(cb.getState("org-1")).toBe("closed");
		});
	});

	describe("open state", () => {
		test("opens after reaching failure threshold with sufficient volume", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 3, volumeThreshold: 3 });
			for (let i = 0; i < 3; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}
			expect(cb.getState("org-1")).toBe("open");
		});

		test("throws CircuitOpenError when circuit is open", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 2, volumeThreshold: 2, resetTimeoutMs: 60_000 });
			for (let i = 0; i < 2; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}

			try {
				await cb.execute("org-1", async () => "should not run");
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(CircuitOpenError);
				expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
			}
		});

		test("isolates orgs — one org's failure doesn't affect another", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 2, volumeThreshold: 2 });
			for (let i = 0; i < 2; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}
			expect(cb.getState("org-1")).toBe("open");
			expect(cb.getState("org-2")).toBe("closed");

			const result = await cb.execute("org-2", async () => "ok");
			expect(result).toBe("ok");
		});
	});

	describe("half-open state", () => {
		test("transitions to half-open after reset timeout", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 2, volumeThreshold: 2, resetTimeoutMs: 10 });
			for (let i = 0; i < 2; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}
			expect(cb.getState("org-1")).toBe("open");

			await new Promise((r) => setTimeout(r, 20));
			expect(cb.getState("org-1")).toBe("half-open");
		});

		test("closes circuit on success in half-open state", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 2, volumeThreshold: 2, resetTimeoutMs: 10 });
			for (let i = 0; i < 2; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}

			await new Promise((r) => setTimeout(r, 20));
			const result = await cb.execute("org-1", async () => "recovered");
			expect(result).toBe("recovered");
			expect(cb.getState("org-1")).toBe("closed");
		});

		test("reopens circuit on failure in half-open state", async () => {
			const cb = createCircuitBreaker({
				failureThreshold: 2,
				volumeThreshold: 2,
				resetTimeoutMs: 10,
				halfOpenMaxAttempts: 1,
			});
			for (let i = 0; i < 2; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}

			await new Promise((r) => setTimeout(r, 20));
			try {
				await cb.execute("org-1", async () => {
					throw new Error("still broken");
				});
			} catch {
				// expected
			}
			expect(cb.getState("org-1")).toBe("open");
		});
	});

	describe("reset", () => {
		test("resets circuit to closed state", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 2, volumeThreshold: 2 });
			for (let i = 0; i < 2; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}
			expect(cb.getState("org-1")).toBe("open");

			cb.reset("org-1");
			expect(cb.getState("org-1")).toBe("closed");
		});

		test("reset allows executing again", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 2, volumeThreshold: 2 });
			for (let i = 0; i < 2; i++) {
				try {
					await cb.execute("org-1", async () => {
						throw new Error("fail");
					});
				} catch {
					// expected
				}
			}

			cb.reset("org-1");
			const result = await cb.execute("org-1", async () => "ok");
			expect(result).toBe("ok");
		});
	});

	describe("stats", () => {
		test("returns undefined for unknown org", () => {
			const cb = createCircuitBreaker();
			expect(cb.stats("org-1")).toBeUndefined();
		});

		test("tracks failure and success counts", async () => {
			const cb = createCircuitBreaker({ failureThreshold: 10, volumeThreshold: 1 });
			await cb.execute("org-1", async () => "ok");
			try {
				await cb.execute("org-1", async () => {
					throw new Error("fail");
				});
			} catch {
				// expected
			}

			const s = cb.stats("org-1");
			expect(s).toBeDefined();
			expect(s?.failures).toBe(1);
			expect(s?.successes).toBe(1);
			expect(s?.totalRequests).toBe(2);
		});
	});
});
