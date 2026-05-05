/**
 * Wave 3K — Spend-request MCP tools.
 *
 * Tools:
 *   spend_request_create               — POST /v1/spend-requests
 *   spend_request_retrieve             — GET  /v1/spend-requests/{id}
 *   spend_request_request_approval     — POST /v1/spend-requests/{id}/request-approval
 *   spend_request_update               — PATCH /v1/spend-requests/{id}
 *   spend_request_list                 — GET  /v1/spend-requests
 *
 * Agents using the Anima MCP server can call these directly without going
 * through the CLI binary. Identical contract to the oRPC HTTP API; tools
 * here are thin wrappers that map snake_case input to the API JSON shape.
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import { toolSuccess, withErrorHandling } from "../../tool-helpers.js";

const lineItemSchema = z.object({
	name: z.string().min(1),
	quantity: z.number().int().positive().optional(),
	unit_amount: z.number().int().nonnegative().optional(),
	description: z.string().optional(),
	sku: z.string().optional(),
	url: z.string().url().optional(),
	image_url: z.string().url().optional(),
	product_url: z.string().url().optional(),
});

const totalSchema = z.object({
	type: z.enum(["subtotal", "tax", "shipping", "discount", "total"]),
	display_text: z.string().min(1),
	amount: z.number().int(),
});

const credentialTypeSchema = z
	.enum(["CARD", "SHARED_PAYMENT_TOKEN", "X402"])
	.describe(
		"CARD = one-time-use virtual card; SHARED_PAYMENT_TOKEN = MPP token; X402 = HTTP 402 settlement.",
	);

const createSchema = z.object({
	agent_id: z.string().describe("Agent creating this spend request."),
	cardholder_id: z.string().describe("Cardholder who must approve."),
	card_id: z.string().optional(),
	amount_cents: z.number().int().positive(),
	currency: z.string().length(3).default("usd"),
	context: z
		.string()
		.min(100)
		.max(2000)
		.describe(
			"Full sentence the cardholder reads when approving. Must be ≥100 characters.",
		),
	merchant_name: z.string().optional(),
	merchant_url: z.string().url().optional(),
	line_items: z.array(lineItemSchema).default([]),
	totals: z.array(totalSchema).default([]),
	credential_type: credentialTypeSchema.default("CARD"),
	request_approval: z
		.boolean()
		.default(false)
		.describe("Trigger email magic-link + webhook approval flow on creation."),
	expires_in_minutes: z.number().int().positive().max(1440).default(60),
	test_mode: z.boolean().default(false),
	metadata: z.record(z.string(), z.unknown()).default({}),
});

const retrieveSchema = z.object({
	id: z.string().describe("Spend request ID."),
	include: z
		.array(z.enum(["card", "spt", "x402_token"]))
		.default([])
		.describe(
			"Sensitive credential fields to include — only valid post-approval.",
		),
});

const updateSchema = z.object({
	id: z.string().describe("Spend request ID."),
	merchant_name: z.string().optional(),
	merchant_url: z.string().url().optional(),
	context: z.string().min(100).max(2000).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const requestApprovalSchema = z.object({
	id: z.string().describe("Spend request ID."),
});

const listSchema = z.object({
	status: z
		.enum([
			"CREATED",
			"PENDING_APPROVAL",
			"APPROVED",
			"DENIED",
			"EXPIRED",
			"CONSUMED",
		])
		.optional(),
	card_id: z.string().optional(),
	cardholder_id: z.string().optional(),
	agent_id: z.string().optional(),
	limit: z.number().int().min(1).max(100).default(20),
	cursor: z.string().optional(),
});

export function registerSpendRequestTools(
	options: ToolRegistrationOptions,
): void {
	const { server } = options;

	server.registerTool(
		"spend_request_create",
		{
			description:
				"Create a spend request — a pre-purchase declaration of intent. Once the cardholder approves (via email magic-link + optional WebAuthn step-up for amounts ≥ \\$200), Anima issues a one-time-use card or shared payment token scoped to this exact request. Use BEFORE attempting to pay at any merchant — the agent never gets a raw card number until approval lands.",
			inputSchema: createSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/v1/spend-requests", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"spend_request_retrieve",
		{
			description:
				"Retrieve a spend request and check its status. Returns CREATED, PENDING_APPROVAL, APPROVED, DENIED, EXPIRED, or CONSUMED. Pass include=['card'] post-approval to fetch the one-time-use card credential, or include=['spt'] for shared payment token. Polls naturally — call repeatedly with a 2s interval until status is terminal.",
			inputSchema: retrieveSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.include.length > 0) params.set("include", args.include.join(","));
			const path = `/v1/spend-requests/${encodeURIComponent(args.id)}${
				params.toString() ? `?${params.toString()}` : ""
			}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"spend_request_request_approval",
		{
			description:
				"Trigger the approval flow on a CREATED spend request. Mints a 5-minute signed token, emails the cardholder a magic link with Approve/Decline buttons, and (if amount ≥ step-up threshold) requires WebAuthn passkey on the approval surface. Idempotent on PENDING_APPROVAL — does not re-email.",
			inputSchema: requestApprovalSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				`/v1/spend-requests/${encodeURIComponent(args.id)}/request-approval`,
				{},
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"spend_request_update",
		{
			description:
				"Update a spend request. Only valid in CREATED state — once approval has been requested or the request has decided, the record is immutable for audit reasons.",
			inputSchema: updateSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const { id, ...rest } = args;
			const result = await context.client.patch<unknown>(
				`/v1/spend-requests/${encodeURIComponent(id)}`,
				rest,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"spend_request_list",
		{
			description:
				"List spend requests in the current org with optional filters by status, card, cardholder, or agent. Cursor-paginated — pass next_cursor from a previous response to continue.",
			inputSchema: listSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.status) params.set("status", args.status);
			if (args.card_id) params.set("card_id", args.card_id);
			if (args.cardholder_id) params.set("cardholder_id", args.cardholder_id);
			if (args.agent_id) params.set("agent_id", args.agent_id);
			params.set("limit", String(args.limit));
			if (args.cursor) params.set("cursor", args.cursor);
			const result = await context.client.get<unknown>(
				`/v1/spend-requests?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);
}
