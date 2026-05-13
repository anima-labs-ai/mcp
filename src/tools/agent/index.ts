import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	deleteOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";

const agentCreateInput = z.object({
	name: z.string().describe("Agent display name"),
	metadata: z
		.record(z.string())
		.optional()
		.describe("Optional agent metadata as key-value string pairs"),
});

const agentGetInput = z.object({
	id: z
		.string()
		.optional()
		.describe(
			"Agent ID. If provided, returns that one agent. If omitted, returns a paginated list of all agents in the org.",
		),
	cursor: z
		.string()
		.optional()
		.describe("Pagination cursor from a previous list response. Ignored when `id` is provided."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of agents to return when listing. Ignored when `id` is provided."),
});

const agentUpdateInput = z.object({
	id: z.string().describe("Agent ID"),
	name: z.string().optional().describe("Updated agent display name"),
	metadata: z
		.record(z.string())
		.optional()
		.describe("Updated metadata as key-value string pairs"),
});

const agentDeleteInput = z.object({
	id: z.string().describe("Agent ID"),
});

function registerAgentCreateTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_create",
		{
			description: "Create a new agent with optional metadata and return the created record. Use this when provisioning a new sending identity or automation actor.",
			inputSchema: agentCreateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post("/v1/agents", args);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentGetTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_get",
		{
			description:
				"Fetch one agent by ID, or list all agents. Pass `id` to inspect a single agent (settings, metadata, status). Omit `id` to list all agents in the current account context — `cursor` and `limit` apply only when listing.",
			inputSchema: agentGetInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			if (args.id) {
				const result = await context.client.get(`/v1/agents/${args.id}`);
				return toolSuccess(result);
			}
			const params = new URLSearchParams();
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/agents?${params.toString()}` : "/v1/agents";
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentUpdateTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_update",
		{
			description: "Update an agent's name or metadata by ID. Use this when an agent needs renaming or profile metadata changes.",
			inputSchema: agentUpdateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const { id, ...body } = args;
			const result = await context.client.patch(`/v1/agents/${id}`, body);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentDeleteTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_delete",
		{
			description: "Delete an agent by ID. Use this to remove deprecated or compromised agents that should no longer send messages.",
			inputSchema: agentDeleteInput.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.delete(`/v1/agents/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerAgentTools(options: ToolRegistrationOptions): void {
	registerAgentCreateTool(options);
	registerAgentGetTool(options);
	registerAgentUpdateTool(options);
	registerAgentDeleteTool(options);
}
