import { describe, test, expect, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import type { ToolContext, ToolRegistrationOptions } from "../tool-helpers.js";
import { registerFundingTools } from "../tools/funding/index.js";

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

function createHarness(): {
	registeredTools: Map<string, RegisteredTool>;
	client: MockApiClient;
	options: ToolRegistrationOptions;
} {
	const registeredTools = new Map<string, RegisteredTool>();
	const client: MockApiClient = {
		get: mock(() => Promise.resolve({ ok: true })),
		post: mock(() => Promise.resolve({ ok: true })),
		patch: mock(() => Promise.resolve({ ok: true })),
		put: mock(() => Promise.resolve({ ok: true })),
		delete: mock(() => Promise.resolve({ ok: true })),
		hasMasterKey: () => true,
	};

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
		hasMasterKey: true,
	};

	return {
		registeredTools,
		client,
		options: { server, context },
	};
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool["handler"] {
	const tool = tools.get(name);
	expect(tool).toBeDefined();
	if (!tool) {
		throw new Error(`Tool not registered: ${name}`);
	}
	return tool.handler;
}

describe("funding MCP tools", () => {
	test("registers all funding tools", () => {
		const harness = createHarness();
		registerFundingTools(harness.options);

		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[
				"funding_create_source",
				"funding_list_sources",
				"funding_create_hold",
				"funding_capture_hold",
				"funding_release_hold",
				"funding_get_hold",
				"funding_list_holds",
			].sort(),
		);
	});

	test("funding_create_source calls POST /api/v1/funding/sources", async () => {
		const harness = createHarness();
		registerFundingTools(harness.options);

		const handler = getTool(harness.registeredTools, "funding_create_source");
		await handler({
			payment_method_id: "pm_123",
			customer_id: "cus_123",
			label: "Main card",
		});

		expect(harness.client.post).toHaveBeenCalledWith(
			"/api/v1/funding/sources",
			expect.objectContaining({
				paymentMethodId: "pm_123",
				customerId: "cus_123",
				label: "Main card",
			}),
		);
	});

	test("funding_capture_hold calls hold capture endpoint", async () => {
		const harness = createHarness();
		registerFundingTools(harness.options);

		const handler = getTool(harness.registeredTools, "funding_capture_hold");
		await handler({ hold_id: "hold_123", amount_cents: 2500 });

		expect(harness.client.post).toHaveBeenCalledWith(
			"/api/v1/funding/holds/hold_123/capture",
			expect.objectContaining({ amountCents: 2500 }),
		);
	});
});
