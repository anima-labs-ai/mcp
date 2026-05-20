/**
 * Phone Call MCP Tools (npm package)
 *
 * 6 tools for phone calls:
 *   - phone_call:                initiate outbound call (REST; the hosted
 *                                server's phone_call streams the live call
 *                                back through the MCP tool — this REST
 *                                version returns a callId immediately)
 *   - phone_call_list:           list calls with filters
 *   - phone_call_get:            full single-call detail (includes summary,
 *                                score, and other derived fields)
 *   - phone_call_transcript_get: transcript by callId
 *   - phone_call_recording_get:  recording URL by callId
 *   - voices_list:               available AI voices for placing calls
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	listOutput,
	objectOutput,
	sendOutput,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";

const phoneCallSchema = z.object({
	agentId: z
		.string()
		.optional()
		.describe("Agent ID to call from (defaults to current agent if using an agent key)."),
	to: z.string().describe("Destination phone number in E.164 format (e.g. +14155551234)."),
	tier: z
		.enum(["basic", "premium"])
		.optional()
		.describe("Voice quality tier (default: basic)."),
	fromNumber: z
		.string()
		.optional()
		.describe("Source number to call from (defaults to agent's primary number)."),
	voiceId: z
		.string()
		.optional()
		.describe("AI voice ID from voices_list to use for the call."),
});

const phoneCallListSchema = z.object({
	agentId: z.string().optional().describe("Filter by agent ID."),
	numberId: z
		.string()
		.optional()
		.describe("Filter by phone identity ID (the number that placed/received the call)."),
	direction: z
		.enum(["INBOUND", "OUTBOUND"])
		.optional()
		.describe("Filter by call direction."),
	status: z
		.string()
		.optional()
		.describe("Filter by call state (INITIATING, RINGING, ACTIVE, ENDED, etc.)."),
	search: z
		.string()
		.optional()
		.describe("Free-text search across transcripts. Note: server-side support pending; pass-through for now."),
	limit: z.number().int().positive().optional().describe("Max results (default: 20)."),
	offset: z.number().int().nonnegative().optional().describe("Offset for pagination."),
});

const phoneCallIdSchema = z.object({
	id: z.string().describe("The call ID."),
});

const voicesListSchema = z.object({
	tier: z
		.enum(["basic", "premium"])
		.optional()
		.describe("Filter by pricing tier."),
	gender: z
		.enum(["male", "female", "neutral"])
		.optional()
		.describe("Filter by voice gender."),
	language: z
		.string()
		.optional()
		.describe("Filter by language code (e.g. 'en-US', 'fr-FR')."),
});

export function registerPhoneCallTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"phone_call_create",
		{
			description:
				"Initiate an outbound phone call from an agent (REST-style: returns a callId immediately). The agent must have a provisioned phone number. For real-time streaming of the call back through the tool invocation, use the hosted MCP server (mcp.useanima.sh) where this tool stays open for the call's lifetime.",
			inputSchema: phoneCallSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = { to: args.to };
			if (args.agentId) body.agentId = args.agentId;
			if (args.tier) body.tier = args.tier;
			if (args.fromNumber) body.fromNumber = args.fromNumber;
			if (args.voiceId) body.voiceId = args.voiceId;
			const result = await context.client.post<unknown>("/v1/voice/calls", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_call_list",
		{
			description:
				"List phone calls with optional filters. Returns lightweight call records — for full call detail including summary and score, use phone_call_get.",
			inputSchema: phoneCallListSchema.shape,
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
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.numberId) params.set("phoneIdentityId", args.numberId);
			if (args.direction) params.set("direction", args.direction);
			if (args.status) params.set("state", args.status);
			if (args.search) params.set("search", args.search);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined) params.set("offset", String(args.offset));
			const path = params.toString() ? `/v1/voice/calls?${params}` : "/v1/voice/calls";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_call_get",
		{
			description:
				"Get full detail for a single phone call: status, duration, participants, tier, AI-generated summary (one-liner, topics, action items, decisions, open questions, next steps), and quality score. The summary is generated once on first read after post-call processing and cached.",
			inputSchema: phoneCallIdSchema.shape,
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
				`/v1/voice/calls/${encodeURIComponent(args.id)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_call_transcript_get",
		{
			description:
				"Get the full transcript of a phone call with speaker labels, timestamps, and confidence scores. Available after the call ends and transcription completes.",
			inputSchema: phoneCallIdSchema.shape,
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
				`/v1/voice/calls/${encodeURIComponent(args.id)}/transcript`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_call_recording_get",
		{
			description:
				"Get a time-limited download URL for a call recording (WAV format). The URL expires after 1 hour. Recording must have been enabled during the call.",
			inputSchema: phoneCallIdSchema.shape,
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
				`/v1/voice/calls/${encodeURIComponent(args.id)}/recording`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"voice_list",
		{
			description:
				"List available AI voices for placing phone calls. Filter by tier (basic for low-latency, premium for natural voices), gender, or language. Returns voice IDs needed for phone_call.",
			inputSchema: voicesListSchema.shape,
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
			if (args.tier) params.set("tier", args.tier);
			if (args.gender) params.set("gender", args.gender);
			if (args.language) params.set("language", args.language);
			const path = params.toString() ? `/v1/voice/catalog?${params}` : "/v1/voice/catalog";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);
}
