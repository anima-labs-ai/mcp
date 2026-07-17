import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../../api-client.js";
import type { ToolContext, ToolRegistrationOptions } from "../../tool-helpers.js";
import { registerAgentTools } from "../../tools/agent/index.js";
import { registerEmailTools } from "../../tools/email/index.js";
import { registerDomainTools } from "../../tools/domain/index.js";
import { registerPhoneTools } from "../../tools/phone/index.js";
import { registerSmsTools } from "../../tools/sms/index.js";
import { registerVaultTools } from "../../tools/vault/index.js";
import { registerWebhookTools } from "../../tools/webhook/index.js";
import { registerWorkspaceTools } from "../../tools/workspace/index.js";

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
		registerSmsTools(options);
		registerVaultTools(options);
		registerWebhookTools(options);
		registerWorkspaceTools(options);
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

	test("agent_list calls GET /agents with query params", async () => {
		const handler = getTool(harness.registeredTools, "agent_list");
		await handler({ cursor: "abc", limit: 10 });
		expect(harness.client.get).toHaveBeenCalledWith("/v1/agents?cursor=abc&limit=10");
	});

	test("agent_get calls GET /agents/{id} (+ addresses)", async () => {
		const handler = getTool(harness.registeredTools, "agent_get");
		await handler({ id: "agent_1" });
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

	test("email_reply works without a master key, like send and forward", async () => {
		// email_reply carried a hardcoded master-key guard its siblings didn't, so
		// the documented stdio setup (ANIMA_API_KEY only) could send and forward
		// mail but never reply. Every other test in this file runs the harness with
		// hasMasterKey=true, which is precisely why nothing caught it — so this one
		// runs WITHOUT one.
		const noMasterKey = createHarness(false);
		noMasterKey.registerAll();
		noMasterKey.client.get.mockResolvedValueOnce({
			id: "orig_1",
			subject: "Question",
			fromAddress: "sender@example.com",
			direction: "INBOUND",
		});

		const handler = getTool(noMasterKey.registeredTools, "email_reply");
		const result = await handler({
			agentId: "agent_1",
			originalId: "orig_1",
			text: "Answer",
		});

		expect(result.isError).toBeUndefined();
		expect(noMasterKey.client.post).toHaveBeenCalledWith(
			"/v1/email/send",
			expect.objectContaining({ to: ["sender@example.com"], subject: "Re: Question" }),
		);
	});

	// B11 — semantic search is the differentiator that was reachable from zero
	// clients. These pin the two things a caller cannot verify for itself: that
	// the mode actually selects a different backing route, and that an
	// email_search result only ever contains email.
	test("email_search defaults to the semantic route, not fulltext", async () => {
		const handler = getTool(harness.registeredTools, "email_search");
		await handler({ query: "the invoice dispute" });

		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/messages/search/semantic",
			expect.objectContaining({ query: "the invoice dispute" }),
		);
	});

	test("email_search fulltext mode uses the keyword route and scopes it to EMAIL", async () => {
		const handler = getTool(harness.registeredTools, "email_search");
		await handler({ query: "INV-42", mode: "fulltext", direction: "INBOUND" });

		expect(harness.client.post).toHaveBeenCalledWith("/v1/messages/search", {
			query: "INV-42",
			// channel is the guard that keeps an "email_search" honest: without it
			// the keyword route happily returns SMS.
			filters: { channel: "EMAIL", direction: "INBOUND" },
			pagination: { limit: 20 },
		});
	});

	test("email_search never returns a non-email as an email", async () => {
		// The semantic route has no channel filter — it ranks across every
		// channel — so an unfiltered passthrough would hand the model an SMS and
		// call it mail.
		//
		// The mock shape is load-bearing and is NOT the list shape used elsewhere:
		// /messages/search/semantic answers `{results: [...]}` with `channel` as the
		// enum cast to text. An earlier version of this test invented `{items: [...]}`,
		// which passed while the real filter never ran — caught only by reading a
		// live prod response.
		harness.client.post.mockResolvedValueOnce({
			results: [
				{ id: "m1", channel: "EMAIL", content: "Invoice", similarity: 0.91 },
				{ id: "m2", channel: "SMS", content: "invoice paid", similarity: 0.88 },
			],
		});

		const handler = getTool(harness.registeredTools, "email_search");
		const result = await handler({ query: "invoice" });
		const parsed = JSON.parse(result.content[0]?.text as string) as {
			items: Array<{ id: string; channel: string }>;
			note?: string;
		};

		expect(parsed.items.map((item) => item.id)).toEqual(["m1"]);
		// Dropping results silently would just relocate the lie, so the caller is told.
		expect(parsed.note).toContain("1 non-email result");
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

	test("domain_create calls POST /v1/domains", async () => {
		const handler = getTool(harness.registeredTools, "domain_create");
		await handler({ domain: "example.com" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/domains",
			expect.objectContaining({ domain: "example.com" }),
		);
	});

	test("phone_number_list with agentId builds query string", async () => {
		const handler = getTool(harness.registeredTools, "phone_number_list");
		await handler({ agentId: "agent_1" });
		expect(harness.client.get).toHaveBeenCalledWith(
			"/v1/phone/numbers?agentId=agent_1",
		);
	});

	test("phone_number_list without agentId omits query string", async () => {
		const handler = getTool(harness.registeredTools, "phone_number_list");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/v1/phone/numbers");
	});

	test("account_overview reads /orgs/me and /orgs/me/workspace-health in parallel", async () => {
		const handler = getTool(harness.registeredTools, "account_overview");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/v1/orgs/me");
		expect(harness.client.get).toHaveBeenCalledWith(
			"/v1/orgs/me/workspace-health",
		);
	});

	test("usage_overview calls GET /orgs/me/usage with no params when period omitted", async () => {
		const handler = getTool(harness.registeredTools, "usage_overview");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/v1/orgs/me/usage");
	});

	test("usage_overview forwards period query param when provided", async () => {
		const handler = getTool(harness.registeredTools, "usage_overview");
		await handler({ period: "2026-05" });
		expect(harness.client.get).toHaveBeenCalledWith(
			"/v1/orgs/me/usage?period=2026-05",
		);
	});

	// ── Vault behavior ────────────────────────────────────────────────────
	// Confirms URL shape for each renamed vault_credential_* tool. The
	// security-critical masking logic is unit-tested in vault-mask.test.ts;
	// here we just verify the handler hits the right endpoint.

	// Was: "builds query string with agentId + type", asserting the request URL
	// carried `&type=login`. It did — and GET /vault/credentials, whose input is
	// {agentId} alone, Zod-stripped it and returned the WHOLE vault. The test
	// passed for the entire life of the bug because it asserted the mechanism
	// (we built a query string) rather than the intent (the caller gets what it
	// asked for). `type` is gone from the tool; the M3 gate now keeps it gone.
	test("vault_credential_list scopes the read to the requested agent", async () => {
		const handler = getTool(harness.registeredTools, "vault_credential_list");
		await handler({ agentId: "agent_v1" });
		expect(harness.client.get).toHaveBeenCalledWith(
			"/v1/vault/credentials?agentId=agent_v1",
		);
	});

	test("vault_credential_get calls GET /vault/credentials/{id} and masks response", async () => {
		harness.client.get.mockResolvedValueOnce({
			id: "cr_1",
			name: "GitHub",
			login: { username: "diyan", password: "secret" },
		});
		const handler = getTool(harness.registeredTools, "vault_credential_get");
		const result = await handler({ id: "cr_1" });

		expect(harness.client.get).toHaveBeenCalledWith("/v1/vault/credentials/cr_1");
		// The handler should mask before returning. Parse the JSON in the
		// tool result and confirm the password is "****", not "secret".
		const parsed = JSON.parse(result.content[0]?.text as string) as {
			login: { password: string };
		};
		expect(parsed.login.password).toBe("****");
	});

	test("vault_credential_create POSTs to /vault/credentials and masks the echo", async () => {
		// The server now masks too, but the tool re-masks on the way out as
		// defence in depth. Confirm a plaintext password in a hypothetical
		// drift scenario still gets masked at the MCP layer.
		harness.client.post.mockResolvedValueOnce({
			id: "cr_2",
			login: { password: "still-plaintext-from-server" },
		});
		const handler = getTool(harness.registeredTools, "vault_credential_create");
		const result = await handler({
			agentId: "agent_v1",
			type: "login",
			name: "Acme",
			login: { username: "u", password: "p" },
		});

		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/vault/credentials",
			expect.objectContaining({ agentId: "agent_v1", type: "login", name: "Acme" }),
		);
		const parsed = JSON.parse(result.content[0]?.text as string) as {
			login: { password: string };
		};
		expect(parsed.login.password).toBe("****");
	});

	test("vault_credential_update PUTs to /vault/credentials/{id} without `id` in body", async () => {
		const handler = getTool(harness.registeredTools, "vault_credential_update");
		await handler({ id: "cr_3", name: "Renamed" });
		expect(harness.client.put).toHaveBeenCalledWith(
			"/v1/vault/credentials/cr_3",
			expect.objectContaining({ name: "Renamed" }),
		);
		// `id` is the path segment, not part of the body payload.
		const putCall = harness.client.put.mock.calls[0];
		expect((putCall?.[1] as Record<string, unknown>)?.id).toBeUndefined();
	});

	test("vault_credential_delete calls DELETE /vault/credentials/{id}", async () => {
		const handler = getTool(harness.registeredTools, "vault_credential_delete");
		await handler({ id: "cr_4" });
		expect(harness.client.delete).toHaveBeenCalledWith("/v1/vault/credentials/cr_4");
	});

	test("vault_credential_search hits /vault/search (NOT /vault/credentials)", async () => {
		// Search uses a separate endpoint — confirms the two access patterns
		// (paginated list vs text search) are routed correctly.
		const handler = getTool(harness.registeredTools, "vault_credential_search");
		await handler({ agentId: "agent_v1", search: "github" });
		expect(harness.client.get).toHaveBeenCalledWith(
			"/v1/vault/search?agentId=agent_v1&search=github",
		);
	});

	test("vault_credential_get_totp calls GET /vault/totp/{id}", async () => {
		const handler = getTool(harness.registeredTools, "vault_credential_get_totp");
		await handler({ id: "cr_5" });
		expect(harness.client.get).toHaveBeenCalledWith("/v1/vault/totp/cr_5");
	});

	// ── Webhook behavior ─────────────────────────────────────────────────
	// The non-trivial logic is webhook_set's upsert routing: PUT when
	// `id` is provided, POST when absent. Both test cases below.

	test("webhook_get calls GET /webhooks/{id}", async () => {
		const handler = getTool(harness.registeredTools, "webhook_get");
		await handler({ id: "wh_1" });
		expect(harness.client.get).toHaveBeenCalledWith("/v1/webhooks/wh_1");
	});

	test("webhook_list with no params calls GET /webhooks (no trailing ?)", async () => {
		// Edge case: empty URLSearchParams stringifies to "" — we should NOT
		// emit "/v1/webhooks?" with a dangling question mark.
		const handler = getTool(harness.registeredTools, "webhook_list");
		await handler({});
		expect(harness.client.get).toHaveBeenCalledWith("/v1/webhooks");
	});

	test("webhook_list forwards cursor + limit as query params", async () => {
		const handler = getTool(harness.registeredTools, "webhook_list");
		await handler({ cursor: "wh_5", limit: 20 });
		expect(harness.client.get).toHaveBeenCalledWith(
			"/v1/webhooks?cursor=wh_5&limit=20",
		);
	});

	test("webhook_set WITHOUT id routes to POST /webhooks (create)", async () => {
		// The upsert routing logic: id absent → create.
		const handler = getTool(harness.registeredTools, "webhook_set");
		await handler({
			url: "https://example.com/hook",
			events: ["message.received"],
			description: "primary",
		});
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/webhooks",
			expect.objectContaining({
				url: "https://example.com/hook",
				events: ["message.received"],
				description: "primary",
			}),
		);
		// PUT was NOT called — this is the create branch.
		expect(harness.client.put).not.toHaveBeenCalled();
	});

	test("webhook_set WITH id routes to PUT /webhooks/{id} (update); id stripped from body", async () => {
		// The upsert routing logic: id present → update. The id becomes the
		// path segment and MUST NOT also appear in the body (PUT body is the
		// update payload, not the resource identity).
		const handler = getTool(harness.registeredTools, "webhook_set");
		await handler({ id: "wh_9", active: false });
		expect(harness.client.put).toHaveBeenCalledWith(
			"/v1/webhooks/wh_9",
			expect.objectContaining({ active: false }),
		);
		const putCall = harness.client.put.mock.calls[0];
		expect((putCall?.[1] as Record<string, unknown>)?.id).toBeUndefined();
		// POST was NOT called — this is the update branch.
		expect(harness.client.post).not.toHaveBeenCalled();
	});

	test("webhook_set forwards auth + throttle advanced settings in the body", async () => {
		// The advanced settings (endpoint auth + delivery throttle) must reach
		// the API body unchanged — the handler spreads the whole input.
		const handler = getTool(harness.registeredTools, "webhook_set");
		await handler({
			url: "https://example.com/hook",
			events: ["message.received"],
			authConfig: { type: "bearer", token: "tok_secret" },
			rateLimitPerMinute: 120,
			maxAttempts: 5,
		});
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/webhooks",
			expect.objectContaining({
				authConfig: { type: "bearer", token: "tok_secret" },
				rateLimitPerMinute: 120,
				maxAttempts: 5,
			}),
		);
	});

	test("webhook_delete calls DELETE /webhooks/{id}", async () => {
		const handler = getTool(harness.registeredTools, "webhook_delete");
		await handler({ id: "wh_10" });
		expect(harness.client.delete).toHaveBeenCalledWith("/v1/webhooks/wh_10");
	});

	test("webhook_test POSTs empty body when no event is provided", async () => {
		// Defensive: the test endpoint accepts an optional `event` field.
		// When omitted, we should send {} (not undefined, not {event: undefined}).
		const handler = getTool(harness.registeredTools, "webhook_test");
		await handler({ id: "wh_11" });
		expect(harness.client.post).toHaveBeenCalledWith("/v1/webhooks/wh_11/test", {});
	});

	test("webhook_test POSTs {event} when event is provided", async () => {
		const handler = getTool(harness.registeredTools, "webhook_test");
		await handler({ id: "wh_12", event: "email.bounced" });
		expect(harness.client.post).toHaveBeenCalledWith(
			"/v1/webhooks/wh_12/test",
			{ event: "email.bounced" },
		);
	});

	test("master-key guarded tools return error without master key", async () => {
		const noMasterHarness = createHarness(false);
		noMasterHarness.registerAll();

		const domainAdd = getTool(noMasterHarness.registeredTools, "domain_create");
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
