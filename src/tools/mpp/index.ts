/**
 * Wave 3K — MPP MCP tools (mpp_pay, mpp_decode).
 *
 * Maps directly to /v1/mpp/{pay,decode}. mpp_decode is fully implemented
 * server-side (parses WWW-Authenticate, returns network_id). mpp_pay returns
 * 501 with workaround until the SPT settlement loop ships in a follow-on.
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import { toolSuccess, withErrorHandling } from "../../tool-helpers.js";

const paySchema = z.object({
	url: z.string().url().describe("URL that returned HTTP 402."),
	spend_request_id: z
		.string()
		.describe(
			"Spend request ID with credential_type=SHARED_PAYMENT_TOKEN and status=APPROVED.",
		),
	method: z.string().default("POST"),
	data: z.unknown().optional().describe("Optional JSON body for the upstream request."),
	headers: z.record(z.string(), z.string()).default({}),
});

const decodeSchema = z.object({
	challenge: z
		.string()
		.min(1)
		.describe(
			"Full WWW-Authenticate header value. May contain multiple Payment challenges; we pick the first supported method (anima, stripe).",
		),
});

export function registerMppTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"mpp_pay",
		{
			description:
				"Settle a machine payment for an HTTP 402 endpoint using a shared payment token. The server probes the URL, parses WWW-Authenticate, builds Authorization: Payment from the SPT, and retries. SPT is one-time-use — if payment fails, create a new spend request.",
			inputSchema: paySchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/v1/mpp/pay", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"mpp_decode",
		{
			description:
				"Decode a WWW-Authenticate Payment challenge (mpp.dev format). Returns extracted network_id, method, and decoded request payload. Use this to determine credential_type before creating a spend request — if the challenge has method='anima' or method='stripe', use credential_type=SHARED_PAYMENT_TOKEN.",
			inputSchema: decodeSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/v1/mpp/decode", args);
			return toolSuccess(result);
		}, options.context),
	);
}
