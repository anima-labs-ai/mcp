import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../../api-client.js";
import type { ToolContext, ToolRegistrationOptions } from "../../tool-helpers.js";
import { registerAgentTools } from "../../tools/agent/index.js";
import { registerEmailTools } from "../../tools/email/index.js";
import { registerDomainTools } from "../../tools/domain/index.js";
import { registerPhoneTools } from "../../tools/phone/index.js";
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
		registerAgentTools(options);
		registerEmailTools(options);
		registerDomainTools(options);
		registerPhoneTools(options);
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

describe("tool behavior integration", () => {
	let harness: ReturnType<typeof createHarness>;

	beforeEach(() => {
		harness = createHarness(true);
		harness.registerAll();
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

		const domainAdd = getTool(noMasterHarness.registeredTools, "domain_add");
		const domainResult = await domainAdd({ domain: "example.com" });

		expect(domainResult.isError).toBe(true);
		expect(domainResult.content[0]?.text).toContain(
			"requires ANIMA_MASTER_KEY",
		);
	});

	test("non-master tools work without master key", async () => {
		const noMasterHarness = createHarness(false);
		noMasterHarness.registerAll();

		const agentGet = getTool(noMasterHarness.registeredTools, "agent_get");
		const result = await agentGet({ id: "agent_42" });

		expect(result.isError).toBeUndefined();
		expect(noMasterHarness.client.get).toHaveBeenCalledWith("/v1/agents/agent_42");
	});

	test("api error is converted to toolError format", async () => {
		harness.client.get.mockRejectedValueOnce(new Error("network down"));
		const handler = getTool(harness.registeredTools, "agent_get");
		const result = await handler({ id: "agent_9" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toBe("Error: network down");
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
