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
import { registerWebhookTools } from "../../tools/webhook/index.js";
import { registerSecurityTools } from "../../tools/security/index.js";
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
		registerWebhookTools(options);
		registerSecurityTools(options);
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
			"/orgs",
			expect.objectContaining({ name: "Test Org" }),
			{ useMasterKey: true },
		);
	});

	test("org_get calls GET /orgs/{id}", async () => {
		const handler = getTool(harness.registeredTools, "org_get");
		await handler({ id: "org_1" });
		expect(harness.client.get).toHaveBeenCalledWith("/orgs/org_1");
	});

	test("agent_list calls GET /agents with query params", async () => {
		const handler = getTool(harness.registeredTools, "agent_list");
		await handler({ cursor: "abc", limit: 10 });
		expect(harness.client.get).toHaveBeenCalledWith("/agents?cursor=abc&limit=10");
	});

	test("email_send calls POST /email/send", async () => {
		const handler = getTool(harness.registeredTools, "email_send");
		await handler({ to: "a@example.com", subject: "Hello", body: "Body" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/email/send",
			expect.objectContaining({ to: "a@example.com", subject: "Hello", body: "Body" }),
		);
	});

	test("email_reply fetches original email then sends reply", async () => {
		harness.client.get.mockImplementation((path: string) => {
			if (path === "/email/orig_1") {
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

		expect(harness.client.get).toHaveBeenCalledWith("/email/orig_1");
		expect(harness.client.post).toHaveBeenCalledWith(
			"/email/send",
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
			"/domains",
			expect.objectContaining({ domain: "example.com" }),
		);
	});

	test("phone_search builds correct query string", async () => {
		const handler = getTool(harness.registeredTools, "phone_search");
		await handler({ countryCode: "US", areaCode: "415", limit: 5 });
		expect(harness.client.get).toHaveBeenCalledWith(
			"/phone/search?countryCode=US&areaCode=415&limit=5",
		);
	});

	test("message_search calls POST /messages/search", async () => {
		const handler = getTool(harness.registeredTools, "message_search");
		await handler({ query: "invoice" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/messages/search",
			expect.objectContaining({ query: "invoice" }),
		);
	});

	test("message_semantic_search calls POST /messages/search/semantic", async () => {
		const handler = getTool(harness.registeredTools, "message_semantic_search");
		await handler({ query: "customer refund", threshold: 0.75, limit: 5 });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/messages/search/semantic",
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
			if (path === "/messages/msg-1") {
				return Promise.resolve({ threadId: "thread-a" });
			}
			if (path === "/messages/msg-2") {
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
			"/messages/search/semantic",
			expect.objectContaining({ query: "refund" }),
		);
		expect(parsed.conversationCount).toBe(1);
		expect(parsed.conversations[0]?.threadId).toBe("thread-a");
		expect(parsed.conversations[0]?.messageCount).toBe(2);
		expect(parsed.conversations[0]?.maxSimilarity).toBe(0.91);
	});

	test("webhook_create calls POST /webhooks", async () => {
		const handler = getTool(harness.registeredTools, "webhook_create");
		await handler({ url: "https://example.com/hook", events: ["message.received"] });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/webhooks",
			expect.objectContaining({
				url: "https://example.com/hook",
				events: ["message.received"],
			}),
		);
	});

	test("security_approve calls POST with orgId/messageId path and master key option", async () => {
		const handler = getTool(harness.registeredTools, "security_approve");
		await handler({ orgId: "org_1", messageId: "msg_1", action: "approve" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/orgs/org_1/messages/msg_1/approve",
			expect.objectContaining({ action: "approve" }),
			{ useMasterKey: true },
		);
	});

	test("whoami calls GET /orgs/me", async () => {
		const handler = getTool(harness.registeredTools, "whoami");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/orgs/me");
	});

	test("check_health calls GET /health", async () => {
		const handler = getTool(harness.registeredTools, "check_health");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/health");
	});

	test("master-key guarded tools return error without master key", async () => {
		const noMasterHarness = createHarness(false);
		noMasterHarness.registerAll();

		const orgCreate = getTool(noMasterHarness.registeredTools, "org_create");
		const securityUpdate = getTool(
			noMasterHarness.registeredTools,
			"security_update_policy",
		);

		const orgResult = await orgCreate({ name: "No Master" });
		const securityResult = await securityUpdate({
			orgId: "org_1",
			agentId: "agent_1",
			scanLevel: "strict",
		});

		expect(orgResult.isError).toBe(true);
		expect(orgResult.content[0]?.text).toContain("requires ANIMA_MASTER_KEY");
		expect(securityResult.isError).toBe(true);
		expect(securityResult.content[0]?.text).toContain(
			"requires ANIMA_MASTER_KEY",
		);
	});

	test("non-master tools work without master key", async () => {
		const noMasterHarness = createHarness(false);
		noMasterHarness.registerAll();

		const orgGet = getTool(noMasterHarness.registeredTools, "org_get");
		const result = await orgGet({ id: "org_42" });

		expect(result.isError).toBeUndefined();
		expect(noMasterHarness.client.get).toHaveBeenCalledWith("/orgs/org_42");
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
		expect(harness.client.post).toHaveBeenCalledWith("/email/batch/read", {
			ids: ["m1", "m2", "m3"],
		});
	});

	test("manage_contacts list action calls GET /contacts", async () => {
		const handler = getTool(harness.registeredTools, "manage_contacts");
		await handler({ action: "list" });
		expect(harness.client.get).toHaveBeenCalledWith("/contacts");
	});

	test("manage_contacts create action calls POST /contacts", async () => {
		const handler = getTool(harness.registeredTools, "manage_contacts");
		await handler({ action: "create", email: "c@example.com", name: "Contact" });
		expect(harness.client.post).toHaveBeenCalledWith("/contacts", {
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

	test("message_send_email maps text/html into unified message payload", async () => {
		const handler = getTool(harness.registeredTools, "message_send_email");
		await handler({
			agentId: "agent_7",
			to: "m@example.com",
			subject: "Mapped",
			html: "<p>H</p>",
		});

		expect(harness.client.post).toHaveBeenCalledWith(
			"/messages/email",
			expect.objectContaining({
				agentId: "agent_7",
				to: ["m@example.com"],
				subject: "Mapped",
				body: "<p>H</p>",
				bodyHtml: "<p>H</p>",
			}),
		);
	});
});
