import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	listOutput,
	objectOutput,
	sendOutput,
	statusOutput,
	toolError,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";
import { drainFollowUps } from "../../pending-followup.js";

const noInput = z.object({});

const managePendingInput = z.object({
	messageId: z.string().describe("Pending message ID"),
	action: z
		.enum(["approve", "reject"])
		.describe("Decision to apply to the pending message"),
	reason: z
		.string()
		.optional()
		.describe("Optional explanation for approval or rejection"),
});

const messageAgentInput = z.object({
	agentName: z.string().min(1).describe("Name of the target agent"),
	subject: z.string().min(1).describe("Email subject"),
	body: z.string().min(1).describe("Email body"),
	priority: z
		.enum(["normal", "high", "urgent"])
		.optional()
		.describe("Optional message priority"),
});

const checkMessagesInput = z.object({
	unreadOnly: z.boolean().optional().describe("Only return unread inbound messages"),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of messages to return"),
});

const waitForEmailInput = z.object({
	timeout: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Timeout in seconds (default 60, max 300)"),
	from: z.string().optional().describe("Optional sender match filter"),
	subject: z.string().optional().describe("Optional subject match filter"),
});

const callAgentInput = z.object({
	agentName: z.string().min(1).describe("Name of the target agent"),
	message: z.string().min(1).describe("Message body to send"),
	timeout: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Timeout in seconds for waiting on reply (default 30)"),
});

const usageOverviewInput = z.object({
	period: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.optional()
		.describe(
			"Billing period in YYYY-MM format (e.g. '2026-05'). Defaults to the current calendar month in UTC.",
		),
});

const manageSpamInput = z.object({
	action: z.enum(["list", "report", "not_spam"]),
	messageId: z.string().optional(),
});

const checkTasksInput = z.object({
	status: z.string().optional().describe("Optional task status filter"),
});

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as JsonObject;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function getAgentsFromResponse(payload: unknown): JsonObject[] {
	if (Array.isArray(payload)) {
		return payload
			.map((entry) => asObject(entry))
			.filter((entry): entry is JsonObject => entry !== null);
	}

	const root = asObject(payload);
	if (!root) return [];

	const items = asArray(root.items);
	return items
		.map((entry) => asObject(entry))
		.filter((entry): entry is JsonObject => entry !== null);
}

function resolveAgentEmail(agent: JsonObject): string | undefined {
	const directEmail = asString(agent.email);
	if (directEmail) return directEmail;

	const identities = asArray(agent.identities);
	for (const identity of identities) {
		const identityObject = asObject(identity);
		if (!identityObject) continue;

		const email =
			asString(identityObject.email) ??
			asString(identityObject.address) ??
			asString(identityObject.value);
		if (email) return email;
	}

	return undefined;
}

function pickMessageFields(message: unknown): JsonObject {
	const messageObject = asObject(message) ?? {};
	return {
		id: messageObject.id,
		from: messageObject.from,
		subject: messageObject.subject,
		status: messageObject.status,
		unread: messageObject.unread,
		receivedAt: messageObject.receivedAt ?? messageObject.createdAt,
	};
}

function isMessageMatch(message: unknown, from?: string, subject?: string): boolean {
	const messageObject = asObject(message);
	if (!messageObject) return false;

	const messageFrom = asString(messageObject.from) ?? "";
	const messageSubject = asString(messageObject.subject) ?? "";

	const fromMatches = from
		? messageFrom.toLowerCase().includes(from.toLowerCase())
		: true;
	const subjectMatches = subject
		? messageSubject.toLowerCase().includes(subject.toLowerCase())
		: true;

	return fromMatches && subjectMatches;
}

function parseMessageTimestamp(message: unknown): number {
	const messageObject = asObject(message);
	if (!messageObject) return 0;

	const dateValue =
		asString(messageObject.receivedAt) ?? asString(messageObject.createdAt);
	if (!dateValue) return 0;

	const parsed = Date.parse(dateValue);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function findAgentByName(payload: unknown, agentName: string): JsonObject | undefined {
	const normalizedName = agentName.toLowerCase();
	const agents = getAgentsFromResponse(payload);
	return agents.find((agent) => {
		const candidateName = asString(agent.name) ?? asString(agent.agentName) ?? "";
		return candidateName.toLowerCase() === normalizedName;
	});
}

function registerAccountOverviewTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"account_overview",
		{
			description:
				"Single-call workspace snapshot: organization context, credential identity, send-capability flags (canSendEmail / canSendSms), inventory counts (agents, domains, phones), and active blockers. Strict superset of the legacy whoami + workspace_health pair. Use this before any non-trivial workflow to answer 'who am I and can I do X right now?' without paying a real send to find out.",
			inputSchema: noInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (_args, context) => {
			// Two parallel reads: /orgs/me gives the full org profile
			// (slug, settings, keyRotatedAt) while /orgs/me/workspace-health
			// gives status, capabilities, inventory, blockers, and the
			// auth-context block that whoami used to surface. Merging at
			// the MCP layer avoids adding a third API endpoint just to
			// reshape the response.
			const [org, health] = await Promise.all([
				context.client.get<Record<string, unknown>>("/v1/orgs/me"),
				context.client.get<Record<string, unknown>>("/v1/orgs/me/workspace-health"),
			]);

			return toolSuccess({
				...health,
				organization: {
					id: org.id,
					name: org.name,
					slug: org.slug,
					tier: org.tier,
					keyRotatedAt: org.keyRotatedAt,
					createdAt: org.createdAt,
				},
			});
		}, options.context),
	);
}

function registerUsageOverviewTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"usage_overview",
		{
			description:
				"Usage rollup for a billing period. Returns counters keyed by usage type (e.g. 'email_sent', 'sms_sent', 'voice_call_minutes') plus the latest update timestamp. Defaults to the current calendar month in UTC when `period` is omitted. Use to answer 'where am I against my tier limits?' without paying for per-event detail.",
			inputSchema: usageOverviewInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.period) params.set("period", args.period);
			const qs = params.toString();
			const url = qs ? `/v1/orgs/me/usage?${qs}` : "/v1/orgs/me/usage";
			const result = await context.client.get(url);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckHealthTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"health_check",
		{
			description: "Check API health status from the server health endpoint. Use this before troubleshooting tool failures to confirm service availability.",
			inputSchema: noInput.shape,
			outputSchema: statusOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (_args, context) => {
			// /health is a root-level Fastify route, not under the /v1 oRPC prefix.
			const result = await context.client.get("/health");
			return toolSuccess(result);
		}, options.context),
	);
}

// list_agents removed 2026-05-13: duplicate of agent_list (registered in
// tools/agent/index.ts). Same handler, same endpoint, same data.

function registerManagePendingTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"pending_manage",
		{
			description: "Approve or reject a pending message requiring manual decision. Use this to unblock held messages with an explicit action and optional reason.",
			inputSchema: managePendingInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(
				`/v1/messages/${args.messageId}/approve`,
				{
					action: args.action,
					reason: args.reason,
				},
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckFollowupsTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"followups_check",
		{
			description: "Drain and return queued follow-up reminders for blocked messages. Use this to poll reminders generated by the pending follow-up scheduler. The drain is consuming — items are removed from the queue on read.",
			inputSchema: noInput.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		withErrorHandling(async () => {
			const result = drainFollowUps();
			return toolSuccess(result);
		}, options.context),
	);
}

function registerMessageAgentTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_message",
		{
			description: "Send an email message to another agent by agent name.",
			inputSchema: messageAgentInput.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const agents = await context.client.get("/v1/agents");
			const targetAgent = findAgentByName(agents, args.agentName);
			if (!targetAgent) {
				return toolError(`Agent not found: ${args.agentName}`);
			}

			const targetEmail = resolveAgentEmail(targetAgent);
			if (!targetEmail) {
				return toolError(`No email identity found for agent: ${args.agentName}`);
			}

			const result = await context.client.post("/v1/messages/email", {
				to: targetEmail,
				subject: args.subject,
				body: args.body,
				priority: args.priority,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckMessagesTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"messages_check",
		{
			description: "Check inbound messages with optional unread-only filtering and compact formatting.",
			inputSchema: checkMessagesInput.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("direction", "inbound");
			if (args.unreadOnly) params.set("unreadOnly", "true");
			if (args.limit) params.set("limit", String(args.limit));

			const messagesResponse = await context.client.get<{ items?: unknown[] }>(
				`/v1/messages?${params.toString()}`,
			);
			const messages = asArray(messagesResponse.items).map((message) =>
				pickMessageFields(message),
			);
			return toolSuccess({ items: messages, count: messages.length });
		}, options.context),
	);
}

function registerWaitForEmailTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"email_wait",
		{
			description: "Poll inbound messages until a matching email arrives or timeout expires. Long-running — the tool blocks for up to `timeout` seconds (capped at 300).",
			inputSchema: waitForEmailInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const startTime = Date.now();
			const timeout = (args.timeout ?? 60) * 1000;
			const maxTimeout = 300000;
			const effectiveTimeout = Math.min(timeout, maxTimeout);

			while (Date.now() - startTime < effectiveTimeout) {
				const messagesResponse = await context.client.get<{ items: unknown[] }>(
					"/v1/messages?direction=inbound&limit=5",
				);
				const messages = asArray(messagesResponse.items);
				const match = messages.find((message) =>
					isMessageMatch(message, args.from, args.subject),
				);

				if (match) {
					return toolSuccess(match);
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));
			}

			return toolError("Timeout waiting for email");
		}, options.context),
	);
}

function registerCallAgentTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_call",
		{
			description: "Send a synchronous request to another agent and wait for reply. Long-running — sends an email then polls for the reply for up to `timeout` seconds.",
			inputSchema: callAgentInput.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const agents = await context.client.get("/v1/agents");
			const targetAgent = findAgentByName(agents, args.agentName);
			if (!targetAgent) {
				return toolError(`Agent not found: ${args.agentName}`);
			}

			const targetEmail = resolveAgentEmail(targetAgent);
			if (!targetEmail) {
				return toolError(`No email identity found for agent: ${args.agentName}`);
			}

			const requestSentAt = Date.now();
			await context.client.post("/v1/messages/email", {
				to: targetEmail,
				subject: `Sync call from ${args.agentName}`,
				body: args.message,
				priority: "high",
			});

			const timeoutMs = (args.timeout ?? 30) * 1000;
			while (Date.now() - requestSentAt < timeoutMs) {
				const response = await context.client.get<{ items: unknown[] }>(
					"/v1/messages?direction=inbound&limit=10",
				);
				const items = asArray(response.items);
				const reply = items.find((message) => {
					const messageObject = asObject(message);
					if (!messageObject) return false;
					const from = asString(messageObject.from) ?? "";
					const fromMatches = from.toLowerCase().includes(targetEmail.toLowerCase());
					const isNew = parseMessageTimestamp(message) >= requestSentAt;
					return fromMatches && isNew;
				});

				if (reply) {
					return toolSuccess(reply);
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));
			}

			return toolError("Timeout waiting for agent reply");
		}, options.context),
	);
}

// me_update removed 2026-05-20: design bug — it mutated the FIRST agent in
// the org's agent list (`agents.items[0]?.id`), not the agent the credential
// actually belongs to. Anyone calling it on a multi-agent org silently
// rewrote a different agent's metadata. The right path for explicit metadata
// updates is agent_update({ id, metadata }) with the ID the caller knows.

// setup_email_domain + send_test_email removed 2026-05-13: pure duplicates
// of domain_add and email_send. Use those canonical tools instead.

function registerManageSpamTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"spam_manage",
		{
			description: "List, report, and unmark spam messages.",
			inputSchema: manageSpamInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			if (args.action === "list") {
				const result = await context.client.get("/v1/messages?status=SPAM");
				return toolSuccess(result);
			}

			if (!args.messageId) {
				return toolError("messageId is required when action is report or not_spam");
			}

			if (args.action === "report") {
				const result = await context.client.post(`/v1/messages/${args.messageId}/spam`, {});
				return toolSuccess(result);
			}

			const result = await context.client.post(
				`/v1/messages/${args.messageId}/not-spam`,
				{},
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckTasksTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"tasks_check",
		{
			description: "Fetch task-assignment messages filtered by metadata type and optional status.",
			inputSchema: checkTasksInput.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("direction", "inbound");
			params.set("metadata.type", "task");
			if (args.status) params.set("status", args.status);

			const result = await context.client.get(`/v1/messages?${params.toString()}`);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerUtilityTools(options: ToolRegistrationOptions): void {
	registerAccountOverviewTool(options);
	registerUsageOverviewTool(options);
	registerCheckHealthTool(options);
	registerManagePendingTool(options);
	registerCheckFollowupsTool(options);
	registerMessageAgentTool(options);
	registerCheckMessagesTool(options);
	registerWaitForEmailTool(options);
	registerCallAgentTool(options);
	registerManageSpamTool(options);
	registerCheckTasksTool(options);
}
