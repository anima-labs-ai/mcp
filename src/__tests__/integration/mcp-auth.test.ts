import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createMcpHttpServer,
	type HttpTransportServer,
	type McpAuthError,
} from "../../http-transport.js";

const MCP_ACCEPT = "application/json, text/event-stream";

function createTestServer(apiKey: string): McpServer {
	const server = new McpServer({ name: "auth-integration-test", version: "1.0.0" }, { capabilities: { tools: {} } });

	server.tool("whoami", "Returns the API key used for this session", {}, async () => ({
		content: [{ type: "text", text: apiKey }],
	}));

	server.tool("add", "Adds two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
		content: [{ type: "text", text: String(a + b) }],
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

function parseSSEJson(sseBody: string): unknown {
	for (const line of sseBody.split("\n")) {
		if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
	}
	return JSON.parse(sseBody);
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

const VALID_PREFIXES = ["ak_", "mk_", "sk_live_", "sk_test_"];

let transport: HttpTransportServer;
let port: number;
let lastAuthenticatedKey: string | undefined;

describe("MCP authenticated session lifecycle", () => {
	beforeEach(async () => {
		lastAuthenticatedKey = undefined;

		transport = createMcpHttpServer(
			() => {
				if (!lastAuthenticatedKey) throw new Error("No authenticated key");
				return createTestServer(lastAuthenticatedKey);
			},
			{
				port: 0,
				authenticate: async (req) => {
					const header = req.headers.authorization;
					if (!header) {
						const err: McpAuthError = { status: 401, message: "Missing Authorization" };
						throw err;
					}

					const match = header.match(/^Bearer\s+(\S+)$/i);
					const token = match?.[1];
					if (!token || !VALID_PREFIXES.some((p) => token.startsWith(p))) {
						const err: McpAuthError = { status: 401, message: "Invalid key format" };
						throw err;
					}

					lastAuthenticatedKey = token;
					return { apiKeyId: token, orgId: "org_test" };
				},
			},
		);

		await new Promise<void>((resolve) => {
			transport.httpServer.listen(0, () => resolve());
		});
		const addr = transport.httpServer.address();
		port = typeof addr === "object" && addr ? addr.port : 0;
	});

	afterEach(async () => {
		await transport.close();
	});

	async function initWithKey(key: string): Promise<{ sessionId: string }> {
		const res = await request(port, "POST", "/mcp", {
			headers: { Accept: MCP_ACCEPT, Authorization: `Bearer ${key}` },
			body: makeInitializeRequest(),
		});
		expect(res.status).toBe(200);
		const sessionId = res.headers.get("mcp-session-id") ?? "";
		expect(sessionId).not.toBe("");

		await request(port, "POST", "/mcp", {
			headers: { Accept: MCP_ACCEPT, "mcp-session-id": sessionId },
			body: { jsonrpc: "2.0", method: "notifications/initialized" },
		});

		return { sessionId };
	}

	async function callTool(sessionId: string, name: string, args: Record<string, unknown> = {}, id = 2) {
		const res = await request(port, "POST", "/mcp", {
			headers: { Accept: MCP_ACCEPT, "mcp-session-id": sessionId },
			body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
		});
		expect(res.status).toBe(200);
		return parseSSEJson(res.body) as { result?: { content: Array<{ text: string }> } };
	}

	test("full lifecycle: auth → init → tool call → close", async () => {
		const { sessionId } = await initWithKey("ak_integration_test_key");

		const result = await callTool(sessionId, "whoami");
		expect(result.result?.content[0]?.text).toBe("ak_integration_test_key");

		const delRes = await request(port, "DELETE", "/mcp", {
			headers: { "mcp-session-id": sessionId },
		});
		expect(delRes.status).toBe(200);
		expect(transport.sessions.size).toBe(0);
	});

	test("tool call returns correct result after auth", async () => {
		const { sessionId } = await initWithKey("ak_math_test");

		const result = await callTool(sessionId, "add", { a: 17, b: 25 });
		expect(result.result?.content[0]?.text).toBe("42");
	});

	test("per-session isolation: different keys get different server instances", async () => {
		const session1 = await initWithKey("ak_user_alpha");
		const session2 = await initWithKey("sk_live_user_beta");

		const result1 = await callTool(session1.sessionId, "whoami", {}, 10);
		expect(result1.result?.content[0]?.text).toBe("ak_user_alpha");

		const result2 = await callTool(session2.sessionId, "whoami", {}, 20);
		expect(result2.result?.content[0]?.text).toBe("sk_live_user_beta");

		expect(transport.sessions.size).toBe(2);
		expect(session1.sessionId).not.toBe(session2.sessionId);
	});

	test("rejected auth prevents tool usage", async () => {
		const res = await request(port, "POST", "/mcp", {
			headers: { Accept: MCP_ACCEPT, Authorization: "Bearer invalid_no_prefix" },
			body: makeInitializeRequest(),
		});
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body).error).toBe("Invalid key format");
		expect(transport.sessions.size).toBe(0);
	});

	test("all valid key prefixes are accepted", async () => {
		const keys = ["ak_test1", "mk_test2", "sk_live_test3", "sk_test_test4"];
		const sessionIds: string[] = [];

		for (const key of keys) {
			const { sessionId } = await initWithKey(key);
			sessionIds.push(sessionId);
		}

		expect(new Set(sessionIds).size).toBe(4);
		expect(transport.sessions.size).toBe(4);
	});

	test("session survives multiple tool calls after single auth", async () => {
		const { sessionId } = await initWithKey("ak_persistent_test");

		for (let i = 0; i < 5; i++) {
			const result = await callTool(sessionId, "add", { a: i, b: i * 2 }, 100 + i);
			expect(result.result?.content[0]?.text).toBe(String(i + i * 2));
		}
	});

	test("closed session cannot be reused", async () => {
		const { sessionId } = await initWithKey("ak_close_test");

		await request(port, "DELETE", "/mcp", {
			headers: { "mcp-session-id": sessionId },
		});

		const res = await request(port, "POST", "/mcp", {
			headers: { Accept: MCP_ACCEPT, "mcp-session-id": sessionId },
			body: { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "whoami", arguments: {} } },
		});
		expect(res.status).toBe(404);
	});
});
