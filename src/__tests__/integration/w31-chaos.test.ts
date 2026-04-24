import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createMcpHttpServer,
	parseBearerToken,
	type HttpTransportOptions,
	type HttpTransportServer,
	type McpAuthContext,
	type McpAuthError,
} from "../../http-transport.js";
import { SERVER_INFO } from "../../config.js";
import type { IncomingMessage } from "node:http";

const MCP_ACCEPT = "application/json, text/event-stream";

function createTestServer(): McpServer {
	const server = new McpServer(SERVER_INFO, {
		capabilities: { tools: {} },
	});
	server.registerTool("slow-echo", { description: "Slow echo for disconnect testing", inputSchema: { message: z.string(), delayMs: z.number() } }, async ({ message, delayMs }) => {
		await new Promise((r) => setTimeout(r, delayMs));
		return { content: [{ type: "text", text: `echo: ${message}` }] };
	});
	server.registerTool("echo", { description: "Simple echo", inputSchema: { message: z.string() } }, async ({ message }) => ({
		content: [{ type: "text", text: `echo: ${message}` }],
	}));
	server.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => {
		throw new Error("intentional failure");
	});
	return server;
}

async function req(
	port: number,
	method: string,
	path: string,
	opts?: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	const url = `http://localhost:${port}${path}`;
	const fetchOpts: RequestInit = {
		method,
		headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...(opts?.headers ?? {}) },
		signal: opts?.signal,
	};
	if (opts?.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);
	const res = await fetch(url, fetchOpts);
	const body = await res.text();
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	return { status: res.status, headers, body };
}

function initBody() {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "chaos-test", version: "1.0.0" },
		},
	};
}

async function initSession(port: number, headers?: Record<string, string>): Promise<string> {
	const res = await req(port, "POST", "/mcp", { body: initBody(), headers });
	const sid = res.headers["mcp-session-id"];
	if (!sid) throw new Error(`No session ID: status=${res.status} body=${res.body}`);
	await req(port, "POST", "/mcp", {
		body: { jsonrpc: "2.0", method: "notifications/initialized" },
		headers: { "mcp-session-id": sid, ...(headers ?? {}) },
	});
	return sid;
}

function validAuth(key = "ak_test123"): Record<string, string> {
	return { Authorization: `Bearer ${key}` };
}

function createAuthenticatedTransport(opts?: {
	rateLimiter?: HttpTransportOptions["rateLimiter"];
	circuitBreaker?: HttpTransportOptions["circuitBreaker"];
	sessionRegistry?: HttpTransportOptions["sessionRegistry"];
}): HttpTransportServer {
	return createMcpHttpServer(createTestServer, {
		port: 0,
		...opts,
		authenticate: async (r: IncomingMessage): Promise<McpAuthContext> => {
			const token = parseBearerToken(r);
			if (!token) {
				const auth = r.headers.authorization;
				if (!auth) {
					const err: McpAuthError = { status: 401, message: "No auth" };
					throw err;
				}
				const err: McpAuthError = { status: 401, message: "Empty token" };
				throw err;
			}
			if (token === "invalid") {
				const err: McpAuthError = { status: 403, message: "Forbidden" };
				throw err;
			}
			return { apiKeyId: token, orgId: `org-${token.slice(0, 5)}` };
		},
	});
}

async function startTransport(transport: HttpTransportServer): Promise<number> {
	await new Promise<void>((resolve) => {
		transport.httpServer.listen(0, () => resolve());
	});
	const addr = transport.httpServer.address();
	return typeof addr === "object" && addr ? addr.port : 0;
}

describe("W31.10 - Chaos and edge-case tests", () => {
	describe("invalid key formats", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createAuthenticatedTransport();
			port = await startTransport(transport);
		});

		afterEach(async () => {
			await transport.close();
		});

		test("rejects empty Authorization header", async () => {
			const res = await req(port, "POST", "/mcp", {
				body: initBody(),
				headers: { Authorization: "" },
			});
			expect(res.status).toBe(401);
		});

		test("rejects Bearer with empty token", async () => {
			const res = await req(port, "POST", "/mcp", {
				body: initBody(),
				headers: { Authorization: "Bearer " },
			});
			expect(res.status).toBe(401);
		});

		test("rejects missing Authorization header", async () => {
			const res = await req(port, "POST", "/mcp", { body: initBody() });
			expect(res.status).toBe(401);
		});

		test("rejects known-invalid credentials", async () => {
			const res = await req(port, "POST", "/mcp", {
				body: initBody(),
				headers: { Authorization: "Bearer invalid" },
			});
			expect(res.status).toBe(403);
		});

		test("tracks all auth failures in metrics", async () => {
			await req(port, "POST", "/mcp", { body: initBody() });
			await req(port, "POST", "/mcp", {
				body: initBody(),
				headers: { Authorization: "Bearer invalid" },
			});
			await req(port, "POST", "/mcp", {
				body: initBody(),
				headers: { Authorization: "" },
			});

			const health = await req(port, "GET", "/health");
			const body = JSON.parse(health.body) as Record<string, unknown>;
			const metrics = body.metrics as Record<string, number>;
			expect(metrics.totalAuthFailures).toBeGreaterThanOrEqual(3);
		});
	});

	describe("concurrent session limits", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createAuthenticatedTransport({
				sessionRegistry: { maxSessionsPerKey: 2 },
				rateLimiter: { requestsPerMinute: 100, sessionsPerKey: 2, toolCallsPerMinute: 100, toolCallsPerHour: 1000 },
			});
			port = await startTransport(transport);
		});

		afterEach(async () => {
			await transport.close();
		});

		test("allows sessions up to the limit", async () => {
			const auth = validAuth("ak_limit1");
			const s1 = await initSession(port, auth);
			const s2 = await initSession(port, auth);
			expect(s1).toBeDefined();
			expect(s2).toBeDefined();
			expect(transport.registry.countByKey("ak_limit1")).toBe(2);
		});

		test("blocks session creation beyond the limit", async () => {
			const auth = validAuth("ak_limit2");
			await initSession(port, auth);
			await initSession(port, auth);

			const res = await req(port, "POST", "/mcp", { body: initBody(), headers: auth });
			expect(res.status).toBe(429);
		});

		test("allows new session after closing one", async () => {
			const auth = validAuth("ak_limit3");
			const s1 = await initSession(port, auth);
			await initSession(port, auth);

			await req(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": s1, ...auth },
			});

			const s3 = await initSession(port, auth);
			expect(s3).toBeDefined();
		});

		test("different keys have independent session limits", async () => {
			const auth1 = validAuth("ak_indep1");
			const auth2 = validAuth("ak_indep2");
			await initSession(port, auth1);
			await initSession(port, auth1);
			await initSession(port, auth2);
			await initSession(port, auth2);

			expect(transport.registry.countByKey("ak_indep1")).toBe(2);
			expect(transport.registry.countByKey("ak_indep2")).toBe(2);
		});
	});

	describe("rate limiting under burst traffic", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createAuthenticatedTransport({
				rateLimiter: { requestsPerMinute: 5, sessionsPerKey: 20, toolCallsPerMinute: 100, toolCallsPerHour: 1000 },
			});
			port = await startTransport(transport);
		});

		afterEach(async () => {
			await transport.close();
		});

		test("rate limits burst of requests from same key", async () => {
			const auth = validAuth("ak_burst1");
			const sid = await initSession(port, auth);
			const headers = { "mcp-session-id": sid, ...auth };

			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					req(port, "POST", "/mcp", {
						body: { jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: "echo", arguments: { message: `burst-${i}` } } },
						headers,
					}),
				),
			);

			const statuses = results.map((r) => r.status);
			expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
			expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
		});

		test("429 responses include Retry-After header", async () => {
			const auth = validAuth("ak_burst2");
			const sid = await initSession(port, auth);
			const headers = { "mcp-session-id": sid, ...auth };

			for (let i = 0; i < 10; i++) {
				const res = await req(port, "POST", "/mcp", {
					body: { jsonrpc: "2.0", id: 200 + i, method: "tools/call", params: { name: "echo", arguments: { message: "x" } } },
					headers,
				});
				if (res.status === 429) {
					expect(res.headers["retry-after"]).toBeDefined();
					break;
				}
			}
		});
	});

	describe("circuit breaker behavior", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createAuthenticatedTransport({
				circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 100, volumeThreshold: 2 },
				rateLimiter: { requestsPerMinute: 100, sessionsPerKey: 20, toolCallsPerMinute: 100, toolCallsPerHour: 1000 },
			});
			port = await startTransport(transport);
		});

		afterEach(async () => {
			await transport.close();
		});

		test("circuit breaker is accessible on transport and starts closed", () => {
			expect(transport.circuitBreaker).toBeDefined();
			expect(transport.circuitBreaker.getState("any-org")).toBe("closed");
		});

		test("circuit breaker tracks org state independently", () => {
			expect(transport.circuitBreaker.getState("org-a")).toBe("closed");
			expect(transport.circuitBreaker.getState("org-b")).toBe("closed");
		});

		test("circuit breaker trips are tracked in metrics", async () => {
			const auth = validAuth("ak_cbmet");
			await initSession(port, auth);

			transport.metrics.circuitBreakerTripped("org-ak_cb");
			transport.metrics.circuitBreakerTripped("org-ak_cb");

			const healthRes = await req(port, "GET", "/health");
			const body = JSON.parse(healthRes.body) as Record<string, unknown>;
			const metrics = body.metrics as Record<string, number>;
			expect(metrics.totalCircuitBreakerTrips).toBe(2);
		});

		test("requests succeed when circuit is closed", async () => {
			const auth = validAuth("ak_cbclosed");
			const sid = await initSession(port, auth);
			const headers = { "mcp-session-id": sid, ...auth };

			const res = await req(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", id: 300, method: "tools/call", params: { name: "echo", arguments: { message: "ok" } } },
				headers,
			});
			expect(res.status).toBe(200);
		});
	});

	describe("session lifecycle edge cases", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createAuthenticatedTransport();
			port = await startTransport(transport);
		});

		afterEach(async () => {
			await transport.close();
		});

		test("request to non-existent session returns 404 or error", async () => {
			const res = await req(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", id: 700, method: "tools/call", params: { name: "echo", arguments: { message: "x" } } },
				headers: { "mcp-session-id": "non-existent-session", ...validAuth() },
			});
			expect([400, 404]).toContain(res.status);
		});

		test("DELETE non-existent session returns 404", async () => {
			const res = await req(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": "non-existent-session", ...validAuth() },
			});
			expect(res.status).toBe(404);
		});

		test("double DELETE same session is idempotent", async () => {
			const auth = validAuth("ak_dblde");
			const sid = await initSession(port, auth);

			const res1 = await req(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sid, ...auth },
			});
			expect(res1.status).toBe(200);

			const res2 = await req(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sid, ...auth },
			});
			expect(res2.status).toBe(404);
		});

		test("POST without session-id or initialize method is rejected", async () => {
			const res = await req(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", id: 800, method: "tools/list" },
				headers: validAuth(),
			});
			expect(res.status).toBeGreaterThanOrEqual(400);
		});

		test("registry tracks tool call count via touch", async () => {
			const auth = validAuth("ak_touch");
			const sid = await initSession(port, auth);
			const headers = { "mcp-session-id": sid, ...auth };

			for (let i = 0; i < 3; i++) {
				await req(port, "POST", "/mcp", {
					body: { jsonrpc: "2.0", id: 900 + i, method: "tools/call", params: { name: "echo", arguments: { message: `msg-${i}` } } },
					headers,
				});
			}

			const meta = transport.registry.get(sid);
			expect(meta).toBeDefined();
			expect(meta?.toolCallCount).toBeGreaterThanOrEqual(3);
		});
	});

	describe("health endpoint resilience", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createAuthenticatedTransport();
			port = await startTransport(transport);
		});

		afterEach(async () => {
			await transport.close();
		});

		test("/health is accessible without authentication", async () => {
			const res = await req(port, "GET", "/health");
			expect(res.status).toBe(200);
		});

		test("/health returns valid JSON structure", async () => {
			const res = await req(port, "GET", "/health");
			const body = JSON.parse(res.body) as Record<string, unknown>;
			expect(body.status).toBe("ok");
			expect(typeof body.uptimeSeconds).toBe("number");
			expect(typeof body.sessions).toBe("number");
			expect(body.metrics).toBeDefined();
			expect(body.registry).toBeDefined();
		});

		test("/health metrics are consistent with activity", async () => {
			const auth = validAuth("ak_hlth1");
			await initSession(port, auth);
			await initSession(port, auth);

			const res = await req(port, "GET", "/health");
			const body = JSON.parse(res.body) as Record<string, unknown>;
			expect(body.sessions).toBe(2);
			const metrics = body.metrics as Record<string, number>;
			expect(metrics.activeSessions).toBe(2);
			expect(metrics.totalSessionsCreated).toBe(2);
		});

		test("unknown routes return 404", async () => {
			const res = await req(port, "GET", "/unknown-path");
			expect(res.status).toBe(404);
		});

		test("unsupported HTTP methods return 405", async () => {
			const res = await req(port, "PUT", "/mcp", {
				body: { test: true },
				headers: validAuth(),
			});
			expect(res.status).toBe(405);
		});
	});

	describe("CORS headers", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createAuthenticatedTransport();
			port = await startTransport(transport);
		});

		afterEach(async () => {
			await transport.close();
		});

		test("OPTIONS returns CORS headers", async () => {
			const res = await req(port, "OPTIONS", "/mcp");
			expect(res.status).toBe(204);
			expect(res.headers["access-control-allow-origin"]).toBe("*");
			expect(res.headers["access-control-allow-methods"]).toBeDefined();
		});

		test("responses include CORS headers", async () => {
			const res = await req(port, "GET", "/health");
			expect(res.headers["access-control-allow-origin"]).toBe("*");
		});
	});
});
