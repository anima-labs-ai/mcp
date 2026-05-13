import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../../api-client.js";
import type { ToolContext, ToolRegistrationOptions } from "../../tool-helpers.js";
import { registerOrganizationTools } from "../../tools/organization/index.js";
import { registerAgentTools } from "../../tools/agent/index.js";
import { registerEmailTools } from "../../tools/email/index.js";
import { registerDomainTools } from "../../tools/domain/index.js";
import { registerPhoneTools } from "../../tools/phone/index.js";
import { registerMessageTools } from "../../tools/message/index.js";
import { registerUtilityTools } from "../../tools/utility/index.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
};

type RegisteredTool = {
	description: string;
	schema: unknown;
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

type MockApiClient = {
	get: ReturnType<typeof mock>;
	post: ReturnType<typeof mock>;
	patch: ReturnType<typeof mock>;
	put: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
	hasMasterKey: () => boolean;
};

function createMockClient(hasMasterKey = true): MockApiClient {
	return {
		get: mock(() => Promise.resolve({ ok: true })),
		post: mock(() => Promise.resolve({ ok: true })),
		patch: mock(() => Promise.resolve({ ok: true })),
		put: mock(() => Promise.resolve({ ok: true })),
		delete: mock(() => Promise.resolve({ ok: true })),
		hasMasterKey: () => hasMasterKey,
	};
}

function createHarness(hasMasterKey = true): {
	registeredTools: Map<string, RegisteredTool>;
	client: MockApiClient;
	registerAll: () => void;
} {
	const registeredTools = new Map<string, RegisteredTool>();
	const client = createMockClient(hasMasterKey);

	const server = {
		tool: mock(
			(
				name: string,
				description: string,
				schema: unknown,
				handler: RegisteredTool["handler"],
			) => {
				registeredTools.set(name, { description, schema, handler });
			},
		),
		// New SDK API after the server.tool → server.registerTool migration.
		registerTool: mock(
			(
				name: string,
				config: { description: string; inputSchema?: unknown },
				handler: RegisteredTool["handler"],
			) => {
				registeredTools.set(name, {
					description: config.description,
					schema: config.inputSchema,
					handler,
				});
			},
		),
		resource: mock(() => undefined),
	} as unknown as McpServer;

	const context: ToolContext = {
		client: client as unknown as ApiClient,
		hasMasterKey,
	};

	const options: ToolRegistrationOptions = { server, context };

	const registerAll = (): void => {
		registerOrganizationTools(options);
		registerAgentTools(options);
		registerEmailTools(options);
		registerDomainTools(options);
		registerPhoneTools(options);
		registerMessageTools(options);
		registerUtilityTools(options);
	};

	return { registeredTools, client, registerAll };
}

function getTool(
	tools: Map<string, RegisteredTool>,
	name: string,
): RegisteredTool["handler"] {
	const tool = tools.get(name);
	expect(tool).toBeDefined();
	if (!tool) {
		throw new Error(`Tool not registered: ${name}`);
	}
	return tool.handler;
}

function parseTextPayload(result: ToolResult): unknown {
	const text = result.content[0]?.text ?? "";
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

describe("tool behavior integration", () => {
	let harness: ReturnType<typeof createHarness>;

	beforeEach(() => {
		harness = createHarness(true);
		harness.registerAll();
	});

	test("org_create calls POST /orgs with master key and body", async () => {
		const handler = getTool(harness.registeredTools, "org_create");
		const result = await handler({ name: "Test Org" });

		expect(result.content[0]?.type).toBe("text");
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/orgs",
			expect.objectContaining({ name: "Test Org" }),
			{ useMasterKey: true },
		);
	});

	test("org_get calls GET /orgs/{id}", async () => {
		const handler = getTool(harness.registeredTools, "org_get");
		await handler({ id: "org_1" });
		expect(harness.client.get).toHaveBeenCalledWith("/v1/orgs/org_1");
	});

	test("agent_get without id calls GET /agents with query params", async () => {
		const handler = getTool(harness.registeredTools, "agent_get");
		await handler({ cursor: "abc", limit: 10 });
		expect(harness.client.get).toHaveBeenCalledWith("/v1/agents?cursor=abc&limit=10");
	});

	test("agent_get with id calls GET /agents/{id} and ignores cursor/limit", async () => {
		const handler = getTool(harness.registeredTools, "agent_get");
		await handler({ id: "agent_1", cursor: "abc", limit: 10 });
		expect(harness.client.get).toHaveBeenCalledWith("/v1/agents/agent_1");
	});

	test("email_send calls POST /email/send", async () => {
		const handler = getTool(harness.registeredTools, "email_send");
		await handler({ to: "a@example.com", subject: "Hello", body: "Body" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/email/send",
			expect.objectContaining({ to: "a@example.com", subject: "Hello", body: "Body" }),
		);
	});

	test("email_reply fetches original email then sends reply", async () => {
		harness.client.get.mockImplementation((path: string) => {
			if (path === "/v1/email/orig_1") {
				return Promise.resolve({
					id: "orig_1",
					subject: "Question",
					from: "sender@example.com",
					references: ["<ref1>"],
				});
			}
			return Promise.resolve({ ok: true });
		});

		const handler = getTool(harness.registeredTools, "email_reply");
		await handler({ originalId: "orig_1", text: "My reply", replyAll: true });

		expect(harness.client.get).toHaveBeenCalledWith("/v1/email/orig_1");
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/email/send",
			expect.objectContaining({
				to: ["sender@example.com"],
				subject: "Re: Question",
				body: "My reply",
				references: expect.arrayContaining(["<ref1>", "orig_1"]),
				inReplyTo: "orig_1",
			}),
		);
	});

	test("domain_add calls POST /domains", async () => {
		const handler = getTool(harness.registeredTools, "domain_add");
		await handler({ domain: "example.com" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/domains",
			expect.objectContaining({ domain: "example.com" }),
		);
	});

	test("phone_search builds correct query string", async () => {
		const handler = getTool(harness.registeredTools, "phone_search");
		await handler({ countryCode: "US", areaCode: "415", limit: 5 });
		expect(harness.client.get).toHaveBeenCalledWith(
			"/v1/phone/search?countryCode=US&areaCode=415&limit=5",
		);
	});

	test("message_search calls POST /messages/search", async () => {
		const handler = getTool(harness.registeredTools, "message_search");
		await handler({ query: "invoice" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/messages/search",
			expect.objectContaining({ query: "invoice" }),
		);
	});

	test("message_semantic_search calls POST /messages/search/semantic", async () => {
		const handler = getTool(harness.registeredTools, "message_semantic_search");
		await handler({ query: "customer refund", threshold: 0.75, limit: 5 });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/messages/search/semantic",
			expect.objectContaining({
				query: "customer refund",
				threshold: 0.75,
				limit: 5,
			}),
		);
	});

	test("conversation_search groups semantic results by thread", async () => {
		harness.client.post.mockResolvedValueOnce({
			results: [
				{
					id: "msg-1",
					content: "refund approved",
					similarity: 0.91,
					channel: "EMAIL",
					direction: "INBOUND",
					createdAt: "2026-01-01T00:00:00.000Z",
					agentId: "agent-1",
				},
				{
					id: "msg-2",
					content: "refund sent",
					similarity: 0.82,
					channel: "EMAIL",
					direction: "OUTBOUND",
					createdAt: "2026-01-02T00:00:00.000Z",
					agentId: "agent-1",
				},
			],
		});

		harness.client.get.mockImplementation((path: string) => {
			if (path === "/v1/messages/msg-1") {
				return Promise.resolve({ threadId: "thread-a" });
			}
			if (path === "/v1/messages/msg-2") {
				return Promise.resolve({ threadId: "thread-a" });
			}
			return Promise.resolve({});
		});

		const handler = getTool(harness.registeredTools, "conversation_search");
		const result = await handler({ topic: "refund" });
		const parsed = parseTextPayload(result) as {
			conversationCount: number;
			conversations: Array<{ threadId: string; messageCount: number; maxSimilarity: number }>;
		};

		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/messages/search/semantic",
			expect.objectContaining({ query: "refund" }),
		);
		expect(parsed.conversationCount).toBe(1);
		expect(parsed.conversations[0]?.threadId).toBe("thread-a");
		expect(parsed.conversations[0]?.messageCount).toBe(2);
		expect(parsed.conversations[0]?.maxSimilarity).toBe(0.91);
	});

	test("whoami calls GET /orgs/me", async () => {
		const handler = getTool(harness.registeredTools, "whoami");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/v1/orgs/me");
	});

	test("health_check calls GET /health", async () => {
		const handler = getTool(harness.registeredTools, "health_check");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/health");
	});

	test("master-key guarded tools return error without master key", async () => {
		const noMasterHarness = createHarness(false);
		noMasterHarness.registerAll();

		const orgCreate = getTool(noMasterHarness.registeredTools, "org_create");
		const domainAdd = getTool(noMasterHarness.registeredTools, "domain_add");

		const orgResult = await orgCreate({ name: "No Master" });
		const domainResult = await domainAdd({ domain: "example.com" });

		expect(orgResult.isError).toBe(true);
		expect(orgResult.content[0]?.text).toContain("requires ANIMA_MASTER_KEY");
		expect(domainResult.isError).toBe(true);
		expect(domainResult.content[0]?.text).toContain(
			"requires ANIMA_MASTER_KEY",
		);
	});

	test("non-master tools work without master key", async () => {
		const noMasterHarness = createHarness(false);
		noMasterHarness.registerAll();

		const orgGet = getTool(noMasterHarness.registeredTools, "org_get");
		const result = await orgGet({ id: "org_42" });

		expect(result.isError).toBeUndefined();
		expect(noMasterHarness.client.get).toHaveBeenCalledWith("/v1/orgs/org_42");
	});

	test("api error is converted to toolError format", async () => {
		harness.client.get.mockRejectedValueOnce(new Error("network down"));
		const handler = getTool(harness.registeredTools, "org_get");
		const result = await handler({ id: "org_9" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toBe("Error: network down");
	});

	test("batch_mark_read sends array of IDs", async () => {
		const handler = getTool(harness.registeredTools, "batch_mark_read");
		await handler({ ids: ["m1", "m2", "m3"] });
		expect(harness.client.post).toHaveBeenCalledWith("/v1/email/batch/read", {
			ids: ["m1", "m2", "m3"],
		});
	});

	test("contacts_manage list action calls GET /contacts", async () => {
		const handler = getTool(harness.registeredTools, "contacts_manage");
		await handler({ action: "list" });
		expect(harness.client.get).toHaveBeenCalledWith("/v1/contacts");
	});

	test("contacts_manage create action calls POST /contacts", async () => {
		const handler = getTool(harness.registeredTools, "contacts_manage");
		await handler({ action: "create", email: "c@example.com", name: "Contact" });
		expect(harness.client.post).toHaveBeenCalledWith("/v1/contacts", {
			email: "c@example.com",
			name: "Contact",
		});
	});

	test("inbox_digest formats response with summary and count", async () => {
		harness.client.get.mockResolvedValueOnce({
			items: [
				{
					from: "alice@example.com",
					subject: "Status",
					date: "2026-01-01T00:00:00Z",
					snippet: "Update ready",
				},
			],
		});

		const handler = getTool(harness.registeredTools, "inbox_digest");
		const result = await handler({ limit: 1 });
		const payload = parseTextPayload(result) as {
			count: number;
			items: Array<{ from: string; subject: string; date: string; snippet: string }>;
			summary: string;
		};

		expect(payload.count).toBe(1);
		expect(payload.items[0]?.from).toBe("alice@example.com");
		expect(payload.summary).toContain("alice@example.com");
		expect(payload.summary).toContain("Status");
	});

	test("tool handlers return MCP text content format", async () => {
		const handler = getTool(harness.registeredTools, "email_send");
		const result = await handler({ to: "x@example.com", subject: "S", text: "T" });

		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		expect(typeof result.content[0]?.text).toBe("string");
	});

	test("email_reply with invalid original payload returns tool error", async () => {
		harness.client.get.mockResolvedValueOnce("invalid payload");
		const handler = getTool(harness.registeredTools, "email_reply");
		const result = await handler({ originalId: "bad_1", text: "Reply" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Original email payload is missing or invalid");
	});

});
