import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	createMcpHttpServer,
	parseBearerToken,
	type HttpTransportServer,
	type McpAuthError,
} from "../../http-transport.js";

const MCP_ACCEPT = "application/json, text/event-stream";

function createTestServer(): McpServer {
	const server = new McpServer({ name: "auth-test", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.registerTool("ping", { description: "Responds with pong", inputSchema: {} }, async () => ({
		content: [{ type: "text", text: "pong" }],
	}));
	return server;
}

async function request(
	port: number,
	method: string,
	path: string,
	opts?: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; headers: Headers; body: string }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: {
			...(opts?.body ? { "Content-Type": "application/json" } : {}),
			...opts?.headers,
		},
		body: opts?.body ? JSON.stringify(opts.body) : undefined,
	});
	return { status: res.status, headers: res.headers, body: await res.text() };
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

async function initSessionWithAuth(
	port: number,
	authHeader?: string,
): Promise<{ status: number; body: string; sessionId?: string }> {
	const headers: Record<string, string> = authHeader
		? { Accept: MCP_ACCEPT, Authorization: authHeader }
		: { Accept: MCP_ACCEPT };

	const res = await request(port, "POST", "/mcp", {
		headers,
		body: makeInitializeRequest(),
	});

	return {
		status: res.status,
		body: res.body,
		sessionId: res.headers.get("mcp-session-id") ?? undefined,
	};
}

let transport: HttpTransportServer;
let port: number;

describe("parseBearerToken", () => {
	test("extracts token from valid Bearer header", () => {
		const req = { headers: { authorization: "Bearer ak_test123" } } as never;
		expect(parseBearerToken(req)).toBe("ak_test123");
	});

	test("returns undefined for missing header", () => {
		const req = { headers: {} } as never;
		expect(parseBearerToken(req)).toBeUndefined();
	});

	test("returns undefined for non-Bearer auth", () => {
		const req = { headers: { authorization: "Basic dXNlcjpwYXNz" } } as never;
		expect(parseBearerToken(req)).toBeUndefined();
	});

	test("handles case-insensitive Bearer prefix", () => {
		const req = { headers: { authorization: "bearer sk_live_abc" } } as never;
		expect(parseBearerToken(req)).toBe("sk_live_abc");
	});

	test("handles extra whitespace between Bearer and token", () => {
		const req = { headers: { authorization: "Bearer   mk_key123" } } as never;
		expect(parseBearerToken(req)).toBe("mk_key123");
	});
});

describe("MCP auth middleware", () => {
	const VALID_TOKEN = "ak_valid_key_123";
	let authenticateCalled: boolean;
	let lastToken: string | undefined;

	beforeEach(async () => {
		authenticateCalled = false;
		lastToken = undefined;

		transport = createMcpHttpServer(createTestServer, {
			port: 0,
			authenticate: async (req) => {
				authenticateCalled = true;
				const header = req.headers.authorization;
				if (!header) {
					const err: McpAuthError = { status: 401, message: "Missing Authorization header" };
					throw err;
				}
				const match = header.match(/^Bearer\s+(\S+)$/i);
				const token = match?.[1];
				if (!token || !token.startsWith("ak_")) {
					const err: McpAuthError = { status: 401, message: "Invalid API key" };
					throw err;
				}
				if (token === "ak_expired_key") {
					const err: McpAuthError = { status: 401, message: "API key expired" };
					throw err;
				}
				lastToken = token;
				return { apiKeyId: token, orgId: "org_test" };
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

	test("rejects initialize without Authorization header", async () => {
		const res = await initSessionWithAuth(port);
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body).error).toBe("Missing Authorization header");
		expect(res.sessionId).toBeUndefined();
		expect(authenticateCalled).toBe(true);
	});

	test("rejects initialize with invalid key format", async () => {
		const res = await initSessionWithAuth(port, "Bearer invalid_key");
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body).error).toBe("Invalid API key");
		expect(res.sessionId).toBeUndefined();
	});

	test("rejects initialize with expired key", async () => {
		const res = await initSessionWithAuth(port, "Bearer ak_expired_key");
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body).error).toBe("API key expired");
	});

	test("rejects initialize with non-Bearer auth scheme", async () => {
		const res = await initSessionWithAuth(port, "Basic dXNlcjpwYXNz");
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body).error).toBe("Invalid API key");
	});

	test("allows initialize with valid API key", async () => {
		const res = await initSessionWithAuth(port, `Bearer ${VALID_TOKEN}`);
		expect(res.status).toBe(200);
		expect(res.sessionId).toBeDefined();
		expect(lastToken).toBe(VALID_TOKEN);
	});

	test("authenticate receives the request object", async () => {
		await initSessionWithAuth(port, `Bearer ${VALID_TOKEN}`);
		expect(authenticateCalled).toBe(true);
		expect(lastToken).toBe(VALID_TOKEN);
	});

	test("subsequent requests on existing session skip auth", async () => {
		const initRes = await initSessionWithAuth(port, `Bearer ${VALID_TOKEN}`);
		expect(initRes.status).toBe(200);
		const sessionId = initRes.sessionId ?? "";
		expect(sessionId).not.toBe("");

		authenticateCalled = false;

		const toolCallRes = await request(port, "POST", "/mcp", {
			headers: {
				Accept: MCP_ACCEPT,
				"mcp-session-id": sessionId,
			},
			body: {
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "ping", arguments: {} },
			},
		});

		expect(toolCallRes.status).toBe(200);
		expect(authenticateCalled).toBe(false);
	});

	test("different sessions can use different API keys", async () => {
		const res1 = await initSessionWithAuth(port, `Bearer ${VALID_TOKEN}`);
		expect(res1.status).toBe(200);
		expect(lastToken).toBe(VALID_TOKEN);

		const otherKey = "ak_other_key_456";
		const res2 = await initSessionWithAuth(port, `Bearer ${otherKey}`);
		expect(res2.status).toBe(200);
		expect(lastToken).toBe(otherKey);

		expect(res1.sessionId).not.toBe(res2.sessionId);
		expect(transport.sessions.size).toBe(2);
	});

	test("auth failure does not create a session", async () => {
		const before = transport.sessions.size;
		await initSessionWithAuth(port, "Bearer invalid_key");
		expect(transport.sessions.size).toBe(before);
	});

	test("health endpoint skips auth", async () => {
		authenticateCalled = false;
		const res = await request(port, "GET", "/health");
		expect(res.status).toBe(200);
		expect(authenticateCalled).toBe(false);
		expect(JSON.parse(res.body).status).toBe("ok");
	});

	test("OPTIONS preflight skips auth", async () => {
		authenticateCalled = false;
		const res = await request(port, "OPTIONS", "/mcp");
		expect(res.status).toBe(204);
		expect(authenticateCalled).toBe(false);
	});

	test("CORS allows Authorization header", async () => {
		const res = await request(port, "OPTIONS", "/mcp");
		const allowHeaders = res.headers.get("access-control-allow-headers") ?? "";
		expect(allowHeaders.toLowerCase()).toContain("authorization");
	});
});

describe("MCP without auth middleware", () => {
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

	test("initialize succeeds without any auth header when no authenticate callback", async () => {
		const res = await initSessionWithAuth(port);
		expect(res.status).toBe(200);
		expect(res.sessionId).toBeDefined();
	});
});
