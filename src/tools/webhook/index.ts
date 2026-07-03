import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";

// Webhook group: 5 tools matching the public API surface.
// webhook_set is an UPSERT — if `id` is provided it routes to PUT
// /webhooks/{id} (update); otherwise to POST /webhooks (create). The
// API has separate create / update endpoints, but exposing both as a
// single MCP tool keeps the agent surface tighter and matches how a
// declarative "ensure webhook X exists with config Y" workflow reads.
// Additional API surface (listDeliveries, stats, reenable, replayDelivery,
// listDeadLetters, eventTypes) is intentionally NOT exposed — those are
// operational/debugging concerns, not agent-driven actions.

const webhookIdInput = z.object({
	id: z.string().describe("Webhook ID"),
});

const webhookListInput = z.object({
	cursor: z.string().optional().describe("Pagination cursor from a previous list call"),
	limit: z
		.number()
		.int()
		.positive()
		.max(100)
		.optional()
		.describe("Maximum number of webhooks to return (1-100)"),
});

const webhookSetInput = z.object({
	id: z
		.string()
		.optional()
		.describe(
			"Webhook ID. Present → updates that webhook (PUT). Omitted → creates a new one (POST).",
		),
	url: z
		.string()
		.url()
		.optional()
		.describe(
			"HTTPS endpoint URL that will receive event payloads. Required on create; optional on update.",
		),
	events: z
		.array(z.string())
		.optional()
		.describe(
			"List of event types to subscribe to (e.g. 'message.received', 'email.bounced'). Required on create; optional on update.",
		),
	description: z.string().optional().describe("Optional human-readable label"),
	active: z
		.boolean()
		.optional()
		.describe("Whether the webhook is active. Defaults to true on create."),
	authConfig: z
		.discriminatedUnion("type", [
			z.object({ type: z.literal("none") }),
			z.object({
				type: z.literal("bearer"),
				token: z.string().min(1).max(4096),
			}),
			z.object({
				type: z.literal("basic"),
				username: z.string().min(1).max(256),
				password: z.string().min(1).max(1024),
			}),
			z.object({
				type: z.literal("custom_header"),
				headerName: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Must be a valid HTTP header name"),
				value: z.string().min(1).max(4096),
			}),
		])
		.optional()
		.describe(
			"Auth the platform presents to your endpoint on each delivery, IN ADDITION to the always-on X-Anima-Signature HMAC. One of: { type: 'none' }, { type: 'bearer', token }, { type: 'basic', username, password }, { type: 'custom_header', headerName, value }. Pass { type: 'none' } to remove existing auth.",
		),
	rateLimitPerMinute: z
		.number()
		.int()
		.positive()
		.max(100000)
		.nullable()
		.optional()
		.describe(
			"Max deliveries per minute to this endpoint. Omit for unlimited; pass null on update to clear it.",
		),
	maxAttempts: z
		.number()
		.int()
		.min(1)
		.max(10)
		.nullable()
		.optional()
		.describe(
			"Max delivery attempts before dead-lettering (1-10, default 3). Pass null on update to reset to the default.",
		),
});

const webhookTestInput = z.object({
	id: z.string().describe("Webhook ID to send a test delivery to"),
	event: z
		.string()
		.optional()
		.describe(
			"Event type to simulate in the test payload (e.g. 'message.received'). Defaults to 'message.received'.",
		),
});

export function registerWebhookTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"webhook_get",
		{
			description:
				"Get a webhook subscription by ID. Returns the full configuration (URL, subscribed events, active state, description).",
			inputSchema: webhookIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/webhooks/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_list",
		{
			description:
				"List webhook subscriptions for the calling org with cursor pagination. Use to enumerate existing webhooks before set/delete operations.",
			inputSchema: webhookListInput.shape,
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
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const qs = params.toString();
			const url = qs ? `/v1/webhooks?${qs}` : "/v1/webhooks";
			const result = await context.client.get<unknown>(url);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_set",
		{
			description:
				"Create or update a webhook subscription. If `id` is provided the call updates that webhook (PUT). If omitted it creates a new one (POST) — `url` and `events` are then required. Use this for declarative 'ensure webhook X exists' workflows where the caller doesn't track which side of create/update it's on.",
			inputSchema: webhookSetInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			if (args.id) {
				const { id, ...payload } = args;
				const path = `/v1/webhooks/${encodeURIComponent(id)}`;
				const result = await context.client.put<unknown>(path, payload);
				return toolSuccess(result);
			}
			const { id: _ignored, ...payload } = args;
			const result = await context.client.post<unknown>("/v1/webhooks", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_delete",
		{
			description:
				"Delete a webhook subscription by ID. Permanently removes the configuration and stops future deliveries. To temporarily pause without deleting, use webhook_set with { id, active: false }.",
			inputSchema: webhookIdInput.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/webhooks/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_test",
		{
			description:
				"Send a test event payload to a webhook to verify the endpoint is reachable and the signature verification on the receiver side works. Returns a deliveryId you can correlate with your endpoint's logs.",
			inputSchema: webhookTestInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/webhooks/${encodeURIComponent(args.id)}/test`;
			const payload: Record<string, unknown> = {};
			if (args.event) payload.event = args.event;
			const result = await context.client.post<unknown>(path, payload);
			return toolSuccess(result);
		}, options.context),
	);
}
