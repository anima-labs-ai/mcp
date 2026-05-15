import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../../api-client.js";
import type { ToolContext, ToolRegistrationOptions } from "../../tool-helpers.js";
import { MASTER_KEY_TOOLS } from "../../config.js";
import { registerOrganizationTools } from "../../tools/organization/index.js";
import { registerAgentTools } from "../../tools/agent/index.js";
import { registerEmailTools } from "../../tools/email/index.js";
import { registerDomainTools } from "../../tools/domain/index.js";
import { registerPhoneTools } from "../../tools/phone/index.js";
import { registerMessageTools } from "../../tools/message/index.js";
import { registerUtilityTools } from "../../tools/utility/index.js";
import { registerVoiceTools } from "../../tools/voice/index.js";
import { registerResources } from "../../resources/index.js";

type RegisteredTool = {
	description: string;
	schema: unknown;
	handler: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: true;
	}>;
};

type RegisteredResource = {
	uri: unknown;
	meta: unknown;
	handler: (uri: URL) => Promise<unknown>;
};

type MockApiClient = {
	get: ReturnType<typeof mock>;
	post: ReturnType<typeof mock>;
	patch: ReturnType<typeof mock>;
	put: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
	hasMasterKey: () => boolean;
};

function createMockContext(hasMasterKey = true): ToolContext {
	const client: MockApiClient = {
		get: mock(() => Promise.resolve({})),
		post: mock(() => Promise.resolve({})),
		patch: mock(() => Promise.resolve({})),
		put: mock(() => Promise.resolve({})),
		delete: mock(() => Promise.resolve({})),
		hasMasterKey: () => hasMasterKey,
	};

	return {
		client: client as unknown as ApiClient,
		hasMasterKey,
	};
}

function createRegistrationHarness(hasMasterKey = true): {
	registeredTools: Map<string, RegisteredTool>;
	registeredResources: Map<string, RegisteredResource>;
	options: ToolRegistrationOptions;
} {
	const registeredTools = new Map<string, RegisteredTool>();
	const registeredResources = new Map<string, RegisteredResource>();

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
		resource: mock(
			(
				name: string,
				uri: unknown,
				meta: unknown,
				handler: RegisteredResource["handler"],
			) => {
				registeredResources.set(name, { uri, meta, handler });
			},
		),
	} as unknown as McpServer;

	const options: ToolRegistrationOptions = {
		server,
		context: createMockContext(hasMasterKey),
	};

	return { registeredTools, registeredResources, options };
}

const expectedDomainTools = {
	organization: [
		"org_create",
		"org_get",
		"org_update",
		"org_delete",
		"org_rotate_key",
		"org_list",
	],
	agent: [
		"agent_create",
		"agent_get",
		"agent_update",
		"agent_delete",
	],
	email: [
		"email_send",
		"email_get",
		"email_reply",
		"email_forward",
		"email_thread_get",
		"email_attachment_get",
		"email_draft_create",
		"email_draft_get",
		"email_draft_send",
		"email_draft_delete",
	],
	domain: [
		"domain_add",
		"domain_verify",
		"domain_get",
		"domain_list",
		"domain_delete",
		"domain_dns_records",
		"domain_update",
		"domain_deliverability",
		"domain_zone_file",
	],
	phone: [
		"phone_search",
		"phone_provision",
		"phone_release",
		"phone_list",
		"phone_send_sms",
		"phone_status",
	],
	message: [
		"message_send_sms",
		"message_search",
		"message_semantic_search",
		"conversation_search",
		"message_upload_attachment",
	],
	utility: [
		"whoami",
		"health_check",
		"pending_manage",
		"followups_check",
		"agent_message",
		"messages_check",
		"email_wait",
		"agent_call",
		"me_update",
		"spam_manage",
		"tasks_check",
	],
	voice: [
		"voice_catalog",
		"voice_call_create",
		"voice_call_list",
		"voice_call_get",
		"voice_transcript_get",
		"voice_recording_get",
		"voice_score_get",
		"voice_call_search",
		"voice_security_scan_get",
	],
} as const;

function assertDescriptionsNonEmpty(
	names: readonly string[],
	registeredTools: Map<string, RegisteredTool>,
): void {
	for (const name of names) {
		const entry = registeredTools.get(name);
		expect(entry).toBeDefined();
		expect(typeof entry?.description).toBe("string");
		expect(entry?.description.trim().length).toBeGreaterThan(0);
	}
}

describe("tool registration integration", () => {
	let harness: ReturnType<typeof createRegistrationHarness>;

	beforeEach(() => {
		harness = createRegistrationHarness(true);
	});

	test("organization registers 6 tools", () => {
		registerOrganizationTools(harness.options);
		expect(harness.registeredTools.size).toBe(6);
	});

	test("agent registers 4 tools", () => {
		registerAgentTools(harness.options);
		expect(harness.registeredTools.size).toBe(4);
	});

	test("email registers 10 tools", () => {
		registerEmailTools(harness.options);
		expect(harness.registeredTools.size).toBe(10);
	});

	test("domain registers 9 tools", () => {
		registerDomainTools(harness.options);
		expect(harness.registeredTools.size).toBe(9);
	});

	test("phone registers 6 tools", () => {
		registerPhoneTools(harness.options);
		expect(harness.registeredTools.size).toBe(6);
	});

	test("message registers 5 tools", () => {
		registerMessageTools(harness.options);
		expect(harness.registeredTools.size).toBe(5);
	});

	test("utility registers 11 tools", () => {
		registerUtilityTools(harness.options);
		expect(harness.registeredTools.size).toBe(11);
	});

	test("organization tool names match expected snake_case names", () => {
		registerOrganizationTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.organization].sort(),
		);
	});

	test("agent tool names match expected snake_case names", () => {
		registerAgentTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.agent].sort(),
		);
	});

	test("email tool names match expected snake_case names", () => {
		registerEmailTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.email].sort(),
		);
	});

	test("domain tool names match expected snake_case names", () => {
		registerDomainTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.domain].sort(),
		);
	});

	test("phone tool names match expected snake_case names", () => {
		registerPhoneTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.phone].sort(),
		);
	});

	test("message tool names match expected snake_case names", () => {
		registerMessageTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.message].sort(),
		);
	});

	test("utility tool names match expected snake_case names", () => {
		registerUtilityTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.utility].sort(),
		);
	});

	test("voice registers 9 tools", () => {
		registerVoiceTools(harness.options);
		expect(harness.registeredTools.size).toBe(9);
	});

	test("voice tool names match expected snake_case names", () => {
		registerVoiceTools(harness.options);
		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[...expectedDomainTools.voice].sort(),
		);
	});

	test("all domains combined register exactly 60 tools", () => {
		registerOrganizationTools(harness.options);
		registerAgentTools(harness.options);
		registerEmailTools(harness.options);
		registerDomainTools(harness.options);
		registerPhoneTools(harness.options);
		registerMessageTools(harness.options);
		registerUtilityTools(harness.options);
		registerVoiceTools(harness.options);

		expect(harness.registeredTools.size).toBe(60);
	});

	test("all registered tool names follow snake_case", () => {
		registerOrganizationTools(harness.options);
		registerAgentTools(harness.options);
		registerEmailTools(harness.options);
		registerDomainTools(harness.options);
		registerPhoneTools(harness.options);
		registerMessageTools(harness.options);
		registerUtilityTools(harness.options);
		registerVoiceTools(harness.options);

		for (const name of harness.registeredTools.keys()) {
			expect(name).toMatch(/^[a-z]+(?:_[a-z0-9]+)*$/);
		}
	});

	test("descriptions are non-empty for all tools in each domain", () => {
		registerOrganizationTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.organization, harness.registeredTools);

		harness = createRegistrationHarness(true);
		registerAgentTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.agent, harness.registeredTools);

		harness = createRegistrationHarness(true);
		registerEmailTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.email, harness.registeredTools);

		harness = createRegistrationHarness(true);
		registerDomainTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.domain, harness.registeredTools);

		harness = createRegistrationHarness(true);
		registerPhoneTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.phone, harness.registeredTools);

		harness = createRegistrationHarness(true);
		registerMessageTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.message, harness.registeredTools);

		harness = createRegistrationHarness(true);
		registerUtilityTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.utility, harness.registeredTools);

		harness = createRegistrationHarness(true);
		registerVoiceTools(harness.options);
		assertDescriptionsNonEmpty(expectedDomainTools.voice, harness.registeredTools);
	});

	test("resources register correctly with 2 resources", () => {
		registerResources(harness.options);
		expect(harness.registeredResources.size).toBe(2);
		expect(harness.registeredResources.has("Agent Inbox")).toBe(true);
		expect(harness.registeredResources.has("Agent Identity")).toBe(true);
	});

	test("MASTER_KEY_TOOLS are a subset of registered tools", () => {
		registerOrganizationTools(harness.options);
		registerAgentTools(harness.options);
		registerEmailTools(harness.options);
		registerDomainTools(harness.options);
		registerPhoneTools(harness.options);
		registerMessageTools(harness.options);
		registerUtilityTools(harness.options);
		registerVoiceTools(harness.options);

		for (const toolName of MASTER_KEY_TOOLS) {
			expect(harness.registeredTools.has(toolName)).toBe(true);
		}
	});
});
