import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createSessionRegistry, type SessionRegistry } from "../../session-registry.js";

describe("SessionRegistry", () => {
	let registry: SessionRegistry;

	beforeEach(() => {
		registry = createSessionRegistry({ sweepIntervalMs: 60_000 });
	});

	afterEach(() => {
		registry.stopSweep();
	});

	describe("register", () => {
		test("registers a session and returns metadata", () => {
			const meta = registry.register("s1", "key-1", "org-1");
			expect(meta.sessionId).toBe("s1");
			expect(meta.apiKeyId).toBe("key-1");
			expect(meta.orgId).toBe("org-1");
			expect(meta.toolCallCount).toBe(0);
			expect(typeof meta.reconnectToken).toBe("string");
			expect(meta.reconnectToken.length).toBeGreaterThan(0);
			expect(meta.createdAt).toBeGreaterThan(0);
			expect(meta.lastActivityAt).toBe(meta.createdAt);
		});

		test("get returns registered session", () => {
			registry.register("s1", "key-1", "org-1");
			const meta = registry.get("s1");
			expect(meta).toBeDefined();
			expect(meta?.apiKeyId).toBe("key-1");
		});

		test("get returns undefined for unknown session", () => {
			expect(registry.get("nonexistent")).toBeUndefined();
		});
	});

	describe("touch", () => {
		test("updates lastActivityAt and increments toolCallCount", () => {
			const meta = registry.register("s1", "key-1", "org-1");
			const initialActivity = meta.lastActivityAt;

			registry.touch("s1");

			const updated = registry.get("s1");
			expect(updated).toBeDefined();
			expect(updated?.lastActivityAt).toBeGreaterThanOrEqual(initialActivity);
			expect(updated?.toolCallCount).toBe(1);
		});

		test("touch on unknown session is a no-op", () => {
			expect(() => registry.touch("nonexistent")).not.toThrow();
		});
	});

	describe("remove", () => {
		test("removes a session", () => {
			registry.register("s1", "key-1", "org-1");
			registry.remove("s1");
			expect(registry.get("s1")).toBeUndefined();
		});

		test("remove on unknown session is a no-op", () => {
			expect(() => registry.remove("nonexistent")).not.toThrow();
		});

		test("reconnect token is cleaned up on remove", () => {
			const meta = registry.register("s1", "key-1", "org-1");
			registry.remove("s1");
			expect(registry.getByReconnectToken(meta.reconnectToken)).toBeUndefined();
		});
	});

	describe("getByReconnectToken", () => {
		test("returns session metadata by reconnect token", () => {
			const meta = registry.register("s1", "key-1", "org-1");
			const found = registry.getByReconnectToken(meta.reconnectToken);
			expect(found).toBeDefined();
			expect(found?.sessionId).toBe("s1");
		});

		test("returns undefined for unknown token", () => {
			expect(registry.getByReconnectToken("bad-token")).toBeUndefined();
		});
	});

	describe("countByKey and countByOrg", () => {
		test("counts sessions by API key", () => {
			registry.register("s1", "key-1", "org-1");
			registry.register("s2", "key-1", "org-1");
			registry.register("s3", "key-2", "org-1");
			expect(registry.countByKey("key-1")).toBe(2);
			expect(registry.countByKey("key-2")).toBe(1);
			expect(registry.countByKey("key-3")).toBe(0);
		});

		test("counts sessions by org", () => {
			registry.register("s1", "key-1", "org-1");
			registry.register("s2", "key-2", "org-1");
			registry.register("s3", "key-3", "org-2");
			expect(registry.countByOrg("org-1")).toBe(2);
			expect(registry.countByOrg("org-2")).toBe(1);
			expect(registry.countByOrg("org-3")).toBe(0);
		});

		test("counts update after remove", () => {
			registry.register("s1", "key-1", "org-1");
			registry.register("s2", "key-1", "org-1");
			registry.remove("s1");
			expect(registry.countByKey("key-1")).toBe(1);
			expect(registry.countByOrg("org-1")).toBe(1);
		});
	});

	describe("canCreateSession", () => {
		test("returns true when under limit", () => {
			const limited = createSessionRegistry({ maxSessionsPerKey: 2 });
			limited.register("s1", "key-1", "org-1");
			expect(limited.canCreateSession("key-1")).toBe(true);
			limited.stopSweep();
		});

		test("returns false when at limit", () => {
			const limited = createSessionRegistry({ maxSessionsPerKey: 2 });
			limited.register("s1", "key-1", "org-1");
			limited.register("s2", "key-1", "org-1");
			expect(limited.canCreateSession("key-1")).toBe(false);
			limited.stopSweep();
		});

		test("returns true for unknown key", () => {
			expect(registry.canCreateSession("new-key")).toBe(true);
		});
	});

	describe("getIdleSessions", () => {
		test("returns sessions past idle timeout", async () => {
			const shortIdle = createSessionRegistry({ idleTimeoutMs: 1 });
			shortIdle.register("s1", "key-1", "org-1");

			await new Promise((r) => setTimeout(r, 5));

			const idle = shortIdle.getIdleSessions();
			expect(idle.length).toBe(1);
			expect(idle[0]).toBe("s1");
			shortIdle.stopSweep();
		});

		test("returns empty when sessions are fresh", () => {
			const longIdle = createSessionRegistry({ idleTimeoutMs: 60_000 });
			longIdle.register("s1", "key-1", "org-1");
			expect(longIdle.getIdleSessions().length).toBe(0);
			longIdle.stopSweep();
		});
	});

	describe("stats", () => {
		test("returns aggregate statistics", () => {
			registry.register("s1", "key-1", "org-1");
			registry.register("s2", "key-2", "org-2");
			const s = registry.stats();
			expect(s.totalSessions).toBe(2);
			expect(s.sessionsByOrg["org-1"]).toBe(1);
			expect(s.sessionsByOrg["org-2"]).toBe(1);
			expect(s.oldestSessionAge).toBeGreaterThanOrEqual(0);
		});

		test("returns null oldest age when empty", () => {
			const s = registry.stats();
			expect(s.totalSessions).toBe(0);
			expect(s.oldestSessionAge).toBeNull();
		});
	});

	describe("sweep", () => {
		test("sweep removes expired sessions via callback", async () => {
			const shortIdle = createSessionRegistry({ idleTimeoutMs: 1, sweepIntervalMs: 100_000 });
			shortIdle.register("s1", "key-1", "org-1");

			const removed: string[] = [];
			shortIdle.startSweep(async (sid: string) => {
				removed.push(sid);
			});

			await new Promise((r) => setTimeout(r, 10));

			const idle = shortIdle.getIdleSessions();
			for (const sid of idle) {
				await (async (s: string) => {
					removed.push(s);
					shortIdle.remove(s);
				})(sid);
			}

			expect(removed).toContain("s1");
			expect(shortIdle.get("s1")).toBeUndefined();
			shortIdle.stopSweep();
		});
	});
});
