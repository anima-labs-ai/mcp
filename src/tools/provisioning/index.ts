import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	listOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";

/**
 * Provisioning requests — how an agent asks its human for infrastructure it
 * cannot create itself.
 *
 * `vault_provision` and `phone_number_provision` are both master-key-only, and
 * an MCP session is authenticated as the agent. Calling either therefore
 * answers 403 forever, which is the dead end this group exists to route
 * around: the agent files a request, the owner approves it in the Anima
 * console, and the resource appears.
 *
 * DELIBERATELY ABSENT: approve and decline.
 *
 * Those exist on the API and are master-gated there, but exposing them as MCP
 * tools would be wrong even for a session that happens to hold a master key.
 * An MCP tool is something the LLM can decide to call, and a prompt-injected
 * agent that can approve its own request can grant itself a billable phone
 * number — which is precisely the escalation the whole flow is designed to
 * prevent. Approving stays a human action in the console, where a human is
 * actually reading it.
 */

const createInput = z.object({
	agentId: z
		.string()
		.describe(
			"Agent the resource would belong to. Omit to use the calling agent.",
		),
	resource: z
		.enum(["VAULT", "PHONE_NUMBER"])
		.describe(
			"What to ask for. VAULT is encrypted secret storage (included on the Free plan); PHONE_NUMBER requires Starter or above.",
		),
	reason: z
		.string()
		.min(1)
		.max(500)
		.describe(
			"Why you need it, in your own words. Shown verbatim to the human who decides — a vague reason is likely to be declined.",
		),
	countryCode: z
		.string()
		.length(2)
		.optional()
		.describe("PHONE_NUMBER only: ISO country code, e.g. 'US'."),
	areaCode: z
		.string()
		.regex(/^\d{3}$/)
		.optional()
		.describe("PHONE_NUMBER only: preferred 3-digit area code."),
});

const listInput = z.object({
	status: z
		.enum(["PENDING", "APPROVED", "DECLINED", "EXPIRED", "CANCELLED"])
		.optional()
		.describe("Filter by lifecycle status."),
	resource: z
		.enum(["VAULT", "PHONE_NUMBER", "GENERIC"])
		.optional()
		.describe(
			"Filter by requested resource. GENERIC rows are master-gated operations you attempted that need your owner's approval — they are filed by the server, not by you.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max results to return."),
});

const requestIdInput = z.object({
	requestId: z.string().min(1).describe("Provisioning request ID."),
});

export function registerProvisioningTools(
	options: ToolRegistrationOptions,
): void {
	const { server } = options;

	server.registerTool(
		"provisioning_request_create",
		{
			description:
				"Ask your human owner to provision a vault or a phone number for you. Use this when a vault operation fails because no vault exists, or when you need a phone number — you cannot provision either yourself, and vault_provision will always be refused. The owner is emailed a link and decides in the Anima console; nothing is created until they approve. Filing the same request twice while one is pending returns the existing one, so retrying is safe.",
			inputSchema: createInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				// Idempotent by server design: an identical pending ask returns
				// the existing request rather than stacking duplicates.
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = {
				resource: args.resource,
				reason: args.reason,
			};
			if (args.agentId) body.agentId = args.agentId;
			const opts: Record<string, string> = {};
			if (args.countryCode) opts.countryCode = args.countryCode;
			if (args.areaCode) opts.areaCode = args.areaCode;
			if (Object.keys(opts).length > 0) body.options = opts;

			const result = await context.client.post<unknown>(
				"/v1/provisioning-requests",
				body,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"provisioning_request_list",
		{
			description:
				"List provisioning requests you have filed and their current status. Use this to check whether an earlier ask was approved before retrying the operation that needed it.",
			inputSchema: listInput.shape,
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
			if (args.status) params.set("status", args.status);
			if (args.resource) params.set("resource", args.resource);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const query = params.toString();
			const result = await context.client.get<unknown>(
				query
					? `/v1/provisioning-requests?${query}`
					: "/v1/provisioning-requests",
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"provisioning_request_status",
		{
			description:
				"Check one provisioning request. A DECLINED request carries the owner's note explaining why — read it and address the objection before asking again, rather than repeating the same request. An APPROVED one carries the id of what was created.",
			inputSchema: requestIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/provisioning-requests/${encodeURIComponent(args.requestId)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"provisioning_request_cancel",
		{
			description:
				"Withdraw a pending request you no longer need, so your owner is not left deciding something nobody wants.",
			inputSchema: requestIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				`/v1/provisioning-requests/${encodeURIComponent(args.requestId)}/cancel`,
				{ requestId: args.requestId },
			);
			return toolSuccess(result);
		}, options.context),
	);
}
