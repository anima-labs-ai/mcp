/**
 * Voice MCP Tools (npm package)
 *
 * 9 tools for voice call intelligence:
 *   - voice_catalog: list available voices
 *   - voice_call_create: initiate outbound call (REST-style; for live LLM-driven
 *     calls within the tool invocation, see voice_call on the hosted server)
 *   - voice_call_list: list past calls
 *   - voice_call_get: get call details + AI-generated summary (cached)
 *   - voice_transcript_get: get call transcript
 *   - voice_recording_get: get recording download URL
 *   - voice_score_get: get call quality score
 *   - voice_call_search: semantic search across transcripts
 *   - voice_security_scan_get: get security scan results
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

export function registerVoiceTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	// ── voice_catalog ──

	server.registerTool(
		"voice_catalog",
		{
			description: "List available AI voices for phone calls. Filter by tier (basic for low-latency, premium for natural voices), gender, or language. Returns voice IDs needed for voice_call_create.",
			inputSchema: {
			tier: z.enum(["basic", "premium"]).optional()
				.describe("Filter by pricing tier."),
			gender: z.enum(["male", "female", "neutral"]).optional()
				.describe("Filter by voice gender."),
			language: z.string().optional()
				.describe("Filter by language code (e.g. 'en-US', 'fr-FR')."),
		},
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

	// ── voice_call_create ──

	server.registerTool(
		"voice_call_create",
		{
			description: "Initiate an outbound voice call from an agent. The agent must have a provisioned phone number. Returns a callId — connect via WebSocket for real-time conversation.",
			inputSchema: {
			agentId: z.string().optional()
				.describe("Agent ID to call from (defaults to current agent if using agent key)."),
			to: z.string()
				.describe("Destination phone number in E.164 format (e.g. +14155551234)."),
			tier: z.enum(["basic", "premium"]).optional()
				.describe("Voice quality tier (default: basic)."),
			fromNumber: z.string().optional()
				.describe("Source number to call from (defaults to agent's primary number)."),
		},
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
			const result = await context.client.post<unknown>("/v1/voice/calls", body);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_call_list ──

	server.registerTool(
		"voice_call_list",
		{
			description: "List voice calls with optional filters. Returns call history with status, direction, duration, and tier info.",
			inputSchema: {
			agentId: z.string().optional()
				.describe("Filter by agent ID."),
			direction: z.enum(["INBOUND", "OUTBOUND"]).optional()
				.describe("Filter by call direction."),
			state: z.string().optional()
				.describe("Filter by call state (INITIATING, RINGING, ACTIVE, ENDED)."),
			limit: z.number().int().positive().optional()
				.describe("Max results (default: 20)."),
			offset: z.number().int().nonnegative().optional()
				.describe("Offset for pagination."),
		},
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
			if (args.direction) params.set("direction", args.direction);
			if (args.state) params.set("state", args.state);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined) params.set("offset", String(args.offset));
			const path = params.toString() ? `/v1/voice/calls?${params}` : "/v1/voice/calls";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_call_get ──

	server.registerTool(
		"voice_call_get",
		{
			description: "Get a voice call: status, duration, participants, tier, AND the AI-generated summary (one-liner, topics, action items, decisions, open questions, next steps, intent, outcome). The summary is generated once on the first read after post-call processing completes and cached on the call row — subsequent calls return the cached value without re-generating.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to retrieve."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}`);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_transcript_get ──

	server.registerTool(
		"voice_transcript_get",
		{
			description: "Get the full transcript of a voice call with speaker labels, timestamps, and confidence scores. Available after the call ends and transcription completes.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get the transcript for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/transcript`);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_recording_get ──

	server.registerTool(
		"voice_recording_get",
		{
			description: "Get a time-limited download URL for a call recording (WAV format). The URL expires after 1 hour. Recording must have been enabled during the call.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get the recording for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/recording`);
			return toolSuccess(result);
		}, options.context),
	);

	// voice_get_summary removed — the summary is now part of voice_call_get's
	// response. The backend generates the summary once on first read and
	// caches it on the call row.

	// ── voice_score_get ──

	server.registerTool(
		"voice_score_get",
		{
			description: "Get the quality score of a call with composite score (0-100), sub-scores (resolution, sentiment, efficiency, engagement, latency, compliance), and detailed metrics (speaking time, dead air, response latency).",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get the score for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/score`);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_call_search ──

	server.registerTool(
		"voice_call_search",
		{
			description: "Semantic search across all call transcripts using natural language. Uses vector similarity to find relevant call segments. Great for finding specific conversations or topics discussed.",
			inputSchema: {
			query: z.string()
				.describe("Natural language search query (e.g. 'billing dispute', 'product demo')."),
			agentId: z.string().optional()
				.describe("Filter results to a specific agent."),
			dateFrom: z.string().optional()
				.describe("Filter from date (ISO 8601)."),
			dateTo: z.string().optional()
				.describe("Filter to date (ISO 8601)."),
			limit: z.number().int().positive().optional()
				.describe("Max results (default: 10)."),
			threshold: z.number().min(0).max(1).optional()
				.describe("Similarity threshold 0-1 (default: 0.7). Lower = more results."),
		},
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = { query: args.query };
			if (args.agentId) body.agentId = args.agentId;
			if (args.dateFrom) body.dateFrom = args.dateFrom;
			if (args.dateTo) body.dateTo = args.dateTo;
			if (args.limit !== undefined) body.limit = args.limit;
			if (args.threshold !== undefined) body.threshold = args.threshold;
			const result = await context.client.post<unknown>("/v1/voice/search", body);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_security_scan_get ──

	server.registerTool(
		"voice_security_scan_get",
		{
			description: "Get security scan results for a call including detected threats (PII leakage, prompt injection, social engineering), compliance pass/fail, and risk score (0-100). Available after post-call security analysis.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get security scan results for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/security`);
			return toolSuccess(result);
		}, options.context),
	);
}
