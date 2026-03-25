import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHttpServer, CORS_HEADERS, type HttpTransportServer } from "../../http-transport.js";

// MCP SDK v1.27.1 requires Accept with both application/json and text/event-stream for POST
const MCP_ACCEPT = "application/json, text/event-stream";

function createTestServer(): McpServer {
	return new McpServer(
		{ name: "test-mcp-server", version: "0.0.1" },
		{ capabilities: { tools: {} } },
	);
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

function parseSSEJson(sseBody: string): unknown {
	const lines = sseBody.split("\n");
	for (const line of lines) {
		if (line.startsWith("data:")) {
			const jsonStr = line.slice("data:".length).trim();
			if (jsonStr) return JSON.parse(jsonStr);
		}
	}
	try {
		return JSON.parse(sseBody);
	} catch {
		throw new Error(`Could not parse SSE or JSON response: ${sseBody.slice(0, 200)}`);
	}
}

function makeInitializeRequest() {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		},
	};
}

async function initSession(port: number): Promise<string> {
	const res = await request(port, "POST", "/mcp", { body: makeInitializeRequest() });
	expect(res.status).toBe(200);
	const sessionId = res.headers["mcp-session-id"];
	expect(sessionId).toBeDefined();
	return sessionId;
}

describe("http-transport", () => {
	let httpTransport: HttpTransportServer;
	let port: number;

	beforeEach(async () => {
		httpTransport = createMcpHttpServer(createTestServer, { port: 0 });

		await new Promise<void>((resolve) => {
			httpTransport.httpServer.listen(0, () => resolve());
		});

		const addr = httpTransport.httpServer.address();
		port = typeof addr === "object" && addr !== null ? addr.port : 0;
		expect(port).toBeGreaterThan(0);
	});

	afterEach(async () => {
		await httpTransport.close();
	});

	describe("CORS preflight", () => {
		test("OPTIONS returns 204 with CORS headers", async () => {
			const res = await request(port, "OPTIONS", "/mcp");
			expect(res.status).toBe(204);
			expect(res.headers["access-control-allow-origin"]).toBe("*");
			expect(res.headers["access-control-allow-methods"]).toContain("POST");
			expect(res.headers["access-control-allow-headers"]).toContain("mcp-session-id");
			expect(res.headers["access-control-expose-headers"]).toContain("mcp-session-id");
		});

		test("OPTIONS works for any path", async () => {
			const res = await request(port, "OPTIONS", "/health");
			expect(res.status).toBe(204);
		});
	});

	describe("health endpoint", () => {
		test("GET /health returns status ok with session count", async () => {
			const res = await request(port, "GET", "/health");
			expect(res.status).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.status).toBe("ok");
			expect(body.sessions).toBe(0);
			expect(typeof body.uptimeSeconds).toBe("number");
			expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
			expect(typeof body.startedAt).toBe("string");
		});

		test("session count reflects active sessions", async () => {
			await initSession(port);
			const healthRes = await request(port, "GET", "/health");
			const body = JSON.parse(healthRes.body);
			expect(body.sessions).toBe(1);
		});
	});

	describe("404 for unknown paths", () => {
		test("GET /unknown returns 404", async () => {
			const res = await request(port, "GET", "/unknown");
			expect(res.status).toBe(404);
			const body = JSON.parse(res.body);
			expect(body.error).toBe("Not Found");
		});

		test("POST /other returns 404", async () => {
			const res = await request(port, "POST", "/other", { body: {} });
			expect(res.status).toBe(404);
		});
	});

	describe("POST /mcp — session creation", () => {
		test("POST without session ID and non-initialize request returns 400", async () => {
			const res = await request(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
			});
			expect(res.status).toBe(400);
			const body = JSON.parse(res.body);
			expect(body.error).toContain("initialize");
		});

		test("POST without session ID with initialize request creates session", async () => {
			const res = await request(port, "POST", "/mcp", {
				body: makeInitializeRequest(),
			});
			expect(res.status).toBe(200);
			expect(res.headers["mcp-session-id"]).toBeDefined();
			expect(res.headers["mcp-session-id"]?.length).toBeGreaterThan(0);
			expect(httpTransport.sessions.size).toBe(1);
		});

		test("POST with invalid session ID returns 404", async () => {
			const res = await request(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
				headers: { "mcp-session-id": "nonexistent-session-id" },
			});
			expect(res.status).toBe(404);
			const body = JSON.parse(res.body);
			expect(body.error).toContain("Session not found");
		});

		test("POST with valid session ID routes to existing transport", async () => {
			const sessionId = await initSession(port);

			await request(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", method: "notifications/initialized" },
				headers: { "mcp-session-id": sessionId },
			});

			const pingRes = await request(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
				headers: { "mcp-session-id": sessionId },
			});
			expect(pingRes.status).toBe(200);
			const body = parseSSEJson(pingRes.body) as Record<string, unknown>;
			expect(body.jsonrpc).toBe("2.0");
			expect(body.id).toBe(2);
			expect(body.result).toBeDefined();
		});
	});

	describe("invalid JSON body", () => {
		test("POST with invalid JSON returns 400", async () => {
			const url = `http://localhost:${port}/mcp`;
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
				body: "not-valid-json{{{",
			});
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("Invalid JSON");
		});
	});

	describe("unsupported method", () => {
		test("PATCH returns 405", async () => {
			const url = `http://localhost:${port}/mcp`;
			const res = await fetch(url, { method: "PATCH" });
			expect(res.status).toBe(405);
			const body = await res.json();
			expect(body.error).toContain("Method not allowed");
		});

		test("PUT returns 405", async () => {
			const url = `http://localhost:${port}/mcp`;
			const res = await fetch(url, { method: "PUT" });
			expect(res.status).toBe(405);
			const body = await res.json();
			expect(body.error).toContain("Method not allowed");
		});
	});

	describe("GET /mcp — SSE stream", () => {
		test("GET without session ID returns 400", async () => {
			const res = await request(port, "GET", "/mcp");
			expect(res.status).toBe(400);
			const body = JSON.parse(res.body);
			expect(body.error).toContain("mcp-session-id");
		});

		test("GET with invalid session ID returns 400", async () => {
			const res = await request(port, "GET", "/mcp", {
				headers: { "mcp-session-id": "invalid-session" },
			});
			expect(res.status).toBe(400);
			const body = JSON.parse(res.body);
			expect(body.error).toContain("mcp-session-id");
		});
	});

	describe("DELETE /mcp — session termination", () => {
		test("DELETE with valid session returns 200", async () => {
			const sessionId = await initSession(port);
			expect(httpTransport.sessions.size).toBe(1);

			const delRes = await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId },
			});
			expect(delRes.status).toBe(200);
			expect(httpTransport.sessions.size).toBe(0);
		});

		test("DELETE with invalid session returns 404", async () => {
			const res = await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": "nonexistent" },
			});
			expect(res.status).toBe(404);
			const body = JSON.parse(res.body);
			expect(body.error).toContain("Session not found");
		});

		test("DELETE without session ID returns 404", async () => {
			const res = await request(port, "DELETE", "/mcp");
			expect(res.status).toBe(404);
		});
	});

	describe("multiple sessions", () => {
		test("can create and manage multiple concurrent sessions", async () => {
			const sessionId1 = await initSession(port);
			const sessionId2 = await initSession(port);

			expect(sessionId1).not.toBe(sessionId2);
			expect(httpTransport.sessions.size).toBe(2);

			const healthRes = await request(port, "GET", "/health");
			const health = JSON.parse(healthRes.body);
			expect(health.sessions).toBe(2);

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId1 },
			});
			expect(httpTransport.sessions.size).toBe(1);

			await request(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", method: "notifications/initialized" },
				headers: { "mcp-session-id": sessionId2 },
			});
		});
	});

	describe("CORS headers on all responses", () => {
		test("CORS headers present on error responses", async () => {
			const res = await request(port, "GET", "/unknown");
			expect(res.headers["access-control-allow-origin"]).toBe("*");
		});

		test("CORS headers present on health response", async () => {
			const res = await request(port, "GET", "/health");
			expect(res.headers["access-control-allow-origin"]).toBe("*");
		});
	});

	describe("close()", () => {
		test("close clears all sessions and stops server", async () => {
			await initSession(port);
			expect(httpTransport.sessions.size).toBe(1);

			await httpTransport.close();
			expect(httpTransport.sessions.size).toBe(0);

			try {
				await fetch(`http://localhost:${port}/health`);
			} catch {
			}
		});

		test("onShutdown callback is invoked on close", async () => {
			let shutdownCalled = false;
			const customTransport = createMcpHttpServer(createTestServer, {
				port: 0,
				onShutdown: () => {
					shutdownCalled = true;
				},
			});

			await new Promise<void>((resolve) => {
				customTransport.httpServer.listen(0, () => resolve());
			});

			await customTransport.close();
			expect(shutdownCalled).toBe(true);
		});
	});
});

describe("CORS_HEADERS export", () => {
	test("contains expected headers", () => {
		expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
		expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("POST");
		expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("DELETE");
		expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toContain("mcp-session-id");
		expect(CORS_HEADERS["Access-Control-Expose-Headers"]).toContain("mcp-session-id");
	});
});
