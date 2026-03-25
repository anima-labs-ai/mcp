import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createMcpHttpServer, type HttpTransportServer, type McpAuthContext, type McpAuthError } from "../../http-transport.js";
import { SERVER_INFO } from "../../config.js";
import type { IncomingMessage } from "node:http";

const MCP_ACCEPT = "application/json, text/event-stream";

function createTestServer(): McpServer {
	const server = new McpServer(SERVER_INFO, {
		capabilities: { tools: {} },
	});
	server.tool("echo", "Echoes the input back", { message: z.string() }, async ({ message }) => ({
		content: [{ type: "text", text: `echo: ${message}` }],
	}));
	return server;
}

async function request(
	port: number,
	method: string,
	path: string,
	options?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	const url = `http://localhost:${port}${path}`;
	const fetchOptions: RequestInit = {
		method,
		headers: {
			"Content-Type": "application/json",
			Accept: MCP_ACCEPT,
			...(options?.headers ?? {}),
		},
	};
	if (options?.body !== undefined) {
		fetchOptions.body = JSON.stringify(options.body);
	}
	const res = await fetch(url, fetchOptions);
	const body = await res.text();
	const headers: Record<string, string> = {};
	res.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return { status: res.status, headers, body };
}

function makeInitBody() {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "infra-test", version: "1.0.0" },
		},
	};
}

async function initSession(port: number, headers?: Record<string, string>): Promise<string> {
	const res = await request(port, "POST", "/mcp", {
		body: makeInitBody(),
		headers,
	});
	const sessionId = res.headers["mcp-session-id"];
	if (!sessionId) throw new Error(`No mcp-session-id in init response (status ${res.status}): ${res.body}`);

	await request(port, "POST", "/mcp", {
		body: { jsonrpc: "2.0", method: "notifications/initialized" },
		headers: { "mcp-session-id": sessionId, ...(headers ?? {}) },
	});
	return sessionId;
}

describe("HTTP transport infrastructure integration", () => {
	describe("session registry tracking", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createMcpHttpServer(createTestServer, { port: 0 });
			await new Promise<void>((resolve) => {
				transport.httpServer.listen(0, () => resolve());
			});
			const addr = transport.httpServer.address();
			port = typeof addr === "object" && addr ? addr.port : 0;
		});

		afterEach(async () => {
			await transport.close();
		});

		test("registry tracks created sessions", async () => {
			const sid = await initSession(port);
			expect(transport.registry.get(sid)).toBeDefined();
			expect(transport.registry.stats().totalSessions).toBe(1);
		});

		test("registry tracks multiple sessions", async () => {
			await initSession(port);
			await initSession(port);
			expect(transport.registry.stats().totalSessions).toBe(2);
		});

		test("registry removes deleted sessions", async () => {
			const sid = await initSession(port);
			expect(transport.registry.get(sid)).toBeDefined();

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sid },
			});
			expect(transport.registry.get(sid)).toBeUndefined();
		});
	});

	describe("metrics via /health endpoint", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createMcpHttpServer(createTestServer, { port: 0 });
			await new Promise<void>((resolve) => {
				transport.httpServer.listen(0, () => resolve());
			});
			const addr = transport.httpServer.address();
			port = typeof addr === "object" && addr ? addr.port : 0;
		});

		afterEach(async () => {
			await transport.close();
		});

		test("/health returns metrics and registry stats", async () => {
			const res = await request(port, "GET", "/health");
			expect(res.status).toBe(200);
			const body = JSON.parse(res.body) as Record<string, unknown>;
			expect(body.status).toBe("ok");
			expect(body.sessions).toBe(0);
			expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
			expect(body.metrics).toBeDefined();
			expect(body.registry).toBeDefined();

			const metrics = body.metrics as Record<string, number>;
			expect(metrics.activeSessions).toBe(0);
			expect(metrics.totalSessionsCreated).toBe(0);
		});

		test("/health metrics update after session activity", async () => {
			const sid = await initSession(port);

			await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 10,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "test" } },
				},
				headers: { "mcp-session-id": sid },
			});

			const res = await request(port, "GET", "/health");
			const body = JSON.parse(res.body) as Record<string, unknown>;
			const metrics = body.metrics as Record<string, number>;
			expect(metrics.activeSessions).toBe(1);
			expect(metrics.totalSessionsCreated).toBe(1);
			expect(metrics.totalToolCalls).toBeGreaterThanOrEqual(1);
		});

		test("/health reflects session closure in metrics", async () => {
			const sid = await initSession(port);

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sid },
			});

			const res = await request(port, "GET", "/health");
			const body = JSON.parse(res.body) as Record<string, unknown>;
			const metrics = body.metrics as Record<string, number>;
			expect(metrics.activeSessions).toBe(0);
			expect(metrics.totalSessionsCreated).toBe(1);
			expect(metrics.totalSessionsClosed).toBeGreaterThanOrEqual(1);
		});
	});

	describe("rate limiting enforcement", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createMcpHttpServer(createTestServer, {
				port: 0,
				rateLimiter: { requestsPerMinute: 3, sessionsPerKey: 2, toolCallsPerMinute: 100, toolCallsPerHour: 1000 },
				authenticate: async (req: IncomingMessage): Promise<McpAuthContext> => {
					const authHeader = req.headers.authorization;
					if (!authHeader) {
						const err: McpAuthError = { status: 401, message: "No auth" };
						throw err;
					}
					const token = authHeader.replace("Bearer ", "");
					return { apiKeyId: token, orgId: "org-test" };
				},
			});
			await new Promise<void>((resolve) => {
				transport.httpServer.listen(0, () => resolve());
			});
			const addr = transport.httpServer.address();
			port = typeof addr === "object" && addr ? addr.port : 0;
		});

		afterEach(async () => {
			await transport.close();
		});

		test("returns 429 after exceeding request rate limit", async () => {
			const authHeaders = { Authorization: "Bearer test-key-rl" };
			const sid = await initSession(port, authHeaders);

			const toolCall = {
				jsonrpc: "2.0",
				id: 20,
				method: "tools/call",
				params: { name: "echo", arguments: { message: "test" } },
			};
			const requestHeaders = { "mcp-session-id": sid, ...authHeaders };

			await request(port, "POST", "/mcp", { body: toolCall, headers: requestHeaders });
			await request(port, "POST", "/mcp", { body: { ...toolCall, id: 21 }, headers: requestHeaders });
			await request(port, "POST", "/mcp", { body: { ...toolCall, id: 22 }, headers: requestHeaders });

			const res = await request(port, "POST", "/mcp", {
				body: { ...toolCall, id: 23 },
				headers: requestHeaders,
			});
			expect(res.status).toBe(429);
			expect(res.headers["retry-after"]).toBeDefined();
		});

		test("returns 401 when no auth provided", async () => {
			const res = await request(port, "POST", "/mcp", { body: makeInitBody() });
			expect(res.status).toBe(401);
		});

		test("tracks rate limit hits in metrics", async () => {
			const authHeaders = { Authorization: "Bearer test-key-rl2" };
			const sid = await initSession(port, authHeaders);

			const toolCall = {
				jsonrpc: "2.0",
				id: 30,
				method: "tools/call",
				params: { name: "echo", arguments: { message: "test" } },
			};
			const requestHeaders = { "mcp-session-id": sid, ...authHeaders };

			for (let i = 0; i < 5; i++) {
				await request(port, "POST", "/mcp", {
					body: { ...toolCall, id: 30 + i },
					headers: requestHeaders,
				});
			}

			const healthRes = await request(port, "GET", "/health");
			const body = JSON.parse(healthRes.body) as Record<string, unknown>;
			const metrics = body.metrics as Record<string, number>;
			expect(metrics.totalRateLimitHits).toBeGreaterThan(0);
		});
	});

	describe("authentication integration", () => {
		let transport: HttpTransportServer;
		let port: number;

		beforeEach(async () => {
			transport = createMcpHttpServer(createTestServer, {
				port: 0,
				authenticate: async (req: IncomingMessage): Promise<McpAuthContext> => {
					const authHeader = req.headers.authorization;
					if (!authHeader) {
						const err: McpAuthError = { status: 401, message: "Missing auth" };
						throw err;
					}
					if (authHeader === "Bearer invalid") {
						const err: McpAuthError = { status: 403, message: "Forbidden" };
						throw err;
					}
					return { apiKeyId: authHeader.replace("Bearer ", ""), orgId: "org-1" };
				},
			});
			await new Promise<void>((resolve) => {
				transport.httpServer.listen(0, () => resolve());
			});
			const addr = transport.httpServer.address();
			port = typeof addr === "object" && addr ? addr.port : 0;
		});

		afterEach(async () => {
			await transport.close();
		});

		test("rejects requests without authentication", async () => {
			const res = await request(port, "POST", "/mcp", { body: makeInitBody() });
			expect(res.status).toBe(401);
			const body = JSON.parse(res.body) as Record<string, string>;
			expect(body.error).toBe("Missing auth");
		});

		test("rejects requests with invalid credentials", async () => {
			const res = await request(port, "POST", "/mcp", {
				body: makeInitBody(),
				headers: { Authorization: "Bearer invalid" },
			});
			expect(res.status).toBe(403);
		});

		test("accepts requests with valid credentials", async () => {
			const sid = await initSession(port, { Authorization: "Bearer valid-key" });
			expect(sid).toBeDefined();
			expect(transport.sessions.size).toBe(1);
		});

		test("tracks auth failures in metrics", async () => {
			await request(port, "POST", "/mcp", { body: makeInitBody() });
			await request(port, "POST", "/mcp", {
				body: makeInitBody(),
				headers: { Authorization: "Bearer invalid" },
			});

			const healthRes = await request(port, "GET", "/health");
			const body = JSON.parse(healthRes.body) as Record<string, unknown>;
			const metrics = body.metrics as Record<string, number>;
			expect(metrics.totalAuthFailures).toBe(2);
		});

		test("session stores apiKeyId and orgId from auth context", async () => {
			const sid = await initSession(port, { Authorization: "Bearer my-api-key" });
			const session = transport.sessions.get(sid);
			expect(session).toBeDefined();
			expect(session?.apiKeyId).toBe("my-api-key");
			expect(session?.orgId).toBe("org-1");
		});
	});
});
