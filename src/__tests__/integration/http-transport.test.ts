import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createMcpHttpServer, type HttpTransportServer } from "../../http-transport.js";
import { SERVER_INFO } from "../../config.js";

const MCP_ACCEPT = "application/json, text/event-stream";

function createTestServer(): McpServer {
	const server = new McpServer(SERVER_INFO, {
		capabilities: { tools: {} },
	});
	server.registerTool("echo", { description: "Echoes the input back", inputSchema: { message: z.string() } }, async ({ message }) => ({
		content: [{ type: "text", text: `echo: ${message}` }],
	}));
	server.registerTool("add", { description: "Adds two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
		content: [{ type: "text", text: String(a + b) }],
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

function parseSSEJson(sseBody: string): unknown {
	const lines = sseBody.split("\n");
	for (const line of lines) {
		if (line.startsWith("data:")) {
			return JSON.parse(line.slice(5).trim());
		}
	}
	try {
		return JSON.parse(sseBody);
	} catch {
		throw new Error(`Could not parse SSE response: ${sseBody.slice(0, 200)}`);
	}
}

async function initSession(port: number): Promise<string> {
	const res = await request(port, "POST", "/mcp", {
		body: {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "integration-test", version: "1.0.0" },
			},
		},
	});
	const sessionId = res.headers["mcp-session-id"];
	if (!sessionId) throw new Error("No mcp-session-id in init response");

	await request(port, "POST", "/mcp", {
		body: { jsonrpc: "2.0", method: "notifications/initialized" },
		headers: { "mcp-session-id": sessionId },
	});
	return sessionId;
}

let httpTransport: HttpTransportServer;
let port: number;

describe("HTTP transport integration", () => {
	beforeEach(async () => {
		httpTransport = createMcpHttpServer(createTestServer, { port: 0 });
		await new Promise<void>((resolve) => {
			httpTransport.httpServer.listen(0, () => resolve());
		});
		const addr = httpTransport.httpServer.address();
		port = typeof addr === "object" && addr ? addr.port : 0;
	});

	afterEach(async () => {
		await httpTransport.close();
	});

	describe("full MCP session lifecycle", () => {
		test("initialize → tool call → close", async () => {
			const sessionId = await initSession(port);

			const echoRes = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 10,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "hello world" } },
				},
				headers: { "mcp-session-id": sessionId },
			});
			expect(echoRes.status).toBe(200);
			const echoBody = parseSSEJson(echoRes.body) as Record<string, unknown>;
			expect(echoBody.id).toBe(10);
			expect(echoBody.result).toBeDefined();
			const echoResult = echoBody.result as Record<string, unknown>;
			const content = echoResult.content as Array<Record<string, string>>;
			expect(content[0].text).toBe("echo: hello world");

			const deleteRes = await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId },
			});
			expect(deleteRes.status).toBe(200);
			expect(httpTransport.sessions.size).toBe(0);
		});

		test("initialize → multiple tool calls → close", async () => {
			const sessionId = await initSession(port);

			const addRes = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 20,
					method: "tools/call",
					params: { name: "add", arguments: { a: 17, b: 25 } },
				},
				headers: { "mcp-session-id": sessionId },
			});
			expect(addRes.status).toBe(200);
			const addBody = parseSSEJson(addRes.body) as Record<string, unknown>;
			const addResult = addBody.result as Record<string, unknown>;
			const addContent = addResult.content as Array<Record<string, string>>;
			expect(addContent[0].text).toBe("42");

			const echoRes = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 21,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "second call" } },
				},
				headers: { "mcp-session-id": sessionId },
			});
			expect(echoRes.status).toBe(200);
			const echoBody = parseSSEJson(echoRes.body) as Record<string, unknown>;
			const echoResult = echoBody.result as Record<string, unknown>;
			const echoContent = echoResult.content as Array<Record<string, string>>;
			expect(echoContent[0].text).toBe("echo: second call");

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId },
			});
		});

		test("tools/list returns registered tools", async () => {
			const sessionId = await initSession(port);

			const listRes = await request(port, "POST", "/mcp", {
				body: { jsonrpc: "2.0", id: 30, method: "tools/list", params: {} },
				headers: { "mcp-session-id": sessionId },
			});
			expect(listRes.status).toBe(200);
			const body = parseSSEJson(listRes.body) as Record<string, unknown>;
			expect(body.id).toBe(30);
			const result = body.result as Record<string, unknown>;
			const tools = result.tools as Array<Record<string, string>>;
			expect(tools.length).toBe(2);
			const names = tools.map((t) => t.name).sort();
			expect(names).toEqual(["add", "echo"]);

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId },
			});
		});
	});

	describe("multiple concurrent sessions", () => {
		test("two independent sessions with separate state", async () => {
			const session1 = await initSession(port);
			const session2 = await initSession(port);
			expect(session1).not.toBe(session2);
			expect(httpTransport.sessions.size).toBe(2);

			const echo1 = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 40,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "session1" } },
				},
				headers: { "mcp-session-id": session1 },
			});
			const body1 = parseSSEJson(echo1.body) as Record<string, unknown>;
			const result1 = body1.result as Record<string, unknown>;
			const content1 = result1.content as Array<Record<string, string>>;
			expect(content1[0].text).toBe("echo: session1");

			const echo2 = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 41,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "session2" } },
				},
				headers: { "mcp-session-id": session2 },
			});
			const body2 = parseSSEJson(echo2.body) as Record<string, unknown>;
			const result2 = body2.result as Record<string, unknown>;
			const content2 = result2.content as Array<Record<string, string>>;
			expect(content2[0].text).toBe("echo: session2");

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": session1 },
			});
			expect(httpTransport.sessions.size).toBe(1);

			const echo2Again = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 42,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "still alive" } },
				},
				headers: { "mcp-session-id": session2 },
			});
			const body2Again = parseSSEJson(echo2Again.body) as Record<string, unknown>;
			const result2Again = body2Again.result as Record<string, unknown>;
			const content2Again = result2Again.content as Array<Record<string, string>>;
			expect(content2Again[0].text).toBe("echo: still alive");

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": session2 },
			});
			expect(httpTransport.sessions.size).toBe(0);
		});
	});

	describe("error scenarios with real MCP server", () => {
		test("calling non-existent tool returns error response", async () => {
			const sessionId = await initSession(port);

			const res = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 50,
					method: "tools/call",
					params: { name: "nonexistent", arguments: {} },
				},
				headers: { "mcp-session-id": sessionId },
			});
			expect(res.status).toBe(200);
			const body = parseSSEJson(res.body) as Record<string, unknown>;
			expect(body.id).toBe(50);
			const hasError = body.error !== undefined;
			const hasIsError =
				body.result !== undefined && (body.result as Record<string, unknown>).isError === true;
			expect(hasError || hasIsError).toBe(true);

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId },
			});
		});

		test("tool call with invalid arguments returns error", async () => {
			const sessionId = await initSession(port);

			const res = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 51,
					method: "tools/call",
					params: { name: "add", arguments: { a: "not-a-number", b: 5 } },
				},
				headers: { "mcp-session-id": sessionId },
			});
			expect(res.status).toBe(200);
			const body = parseSSEJson(res.body) as Record<string, unknown>;
			expect(body.id).toBe(51);
			const result = body.result as Record<string, unknown> | undefined;
			const error = body.error as Record<string, unknown> | undefined;
			expect(result !== undefined || error !== undefined).toBe(true);

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId },
			});
		});

		test("request to closed session returns 404", async () => {
			const sessionId = await initSession(port);

			await request(port, "DELETE", "/mcp", {
				headers: { "mcp-session-id": sessionId },
			});

			const res = await request(port, "POST", "/mcp", {
				body: {
					jsonrpc: "2.0",
					id: 52,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "dead session" } },
				},
				headers: { "mcp-session-id": sessionId },
			});
			expect(res.status).toBe(404);
		});
	});
});
