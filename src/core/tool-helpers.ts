/**
 * Tool Registration Types and Helpers
 *
 * Provides the framework for registering MCP tools organized by domain.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "./api-client.js";
import { MASTER_KEY_TOOLS } from "./config.js";

/**
 * MCP tool annotation hints per spec 2025-11-25. All optional; clients use
 * these to bucket tools (read-only vs. write vs. destructive) in UI
 * permission flows. NOT a security boundary — the spec calls these "hints"
 * and warns clients to treat them as untrusted unless the server is
 * trusted. We surface them so LLM clients with permission gating
 * (Claude Desktop, Cursor) get accurate categorization without parsing
 * descriptions.
 */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** Context passed to each tool handler */
export interface ToolContext {
	client: ApiClient;
	hasMasterKey: boolean;
}

/** Options for tool registration */
export interface ToolRegistrationOptions {
	server: McpServer;
	context: ToolContext;
}

/**
 * Type for a domain-level tool registrar function.
 * Each domain (org, agent, email, etc.) exports a function matching this signature.
 */
export type DomainRegistrar = (options: ToolRegistrationOptions) => void;

/**
 * Check if a tool requires master key access.
 */
export function requiresMasterKey(toolName: string): boolean {
	return MASTER_KEY_TOOLS.has(toolName);
}

/**
 * Format a successful tool response for MCP.
 */
export function toolSuccess(
	data: unknown,
): { content: Array<{ type: "text"; text: string }> } {
	const text =
		typeof data === "string" ? data : JSON.stringify(data, null, 2);
	return {
		content: [{ type: "text" as const, text }],
	};
}

/**
 * Format an error tool response for MCP.
 */
export function toolError(
	message: string,
): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		isError: true,
	};
}

/**
 * Wrapper that catches errors from tool handlers and formats them as MCP errors.
 */
export function withErrorHandling<
	TArgs extends Record<string, unknown>,
>(
	handler: (
		args: TArgs,
		context: ToolContext,
	) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
	context: ToolContext,
): (args: TArgs) => Promise<{
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
}> {
	return async (args: TArgs) => {
		try {
			return await handler(args, context);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			return toolError(message);
		}
	};
}

/**
 * Guard that checks master key availability before executing a tool.
 */
export function requireMasterKeyGuard(context: ToolContext): void {
	if (!context.hasMasterKey) {
		throw new Error(
			"This operation requires ANIMA_MASTER_KEY to be set.",
		);
	}
}

/**
 * Register a tool under multiple names so the LLM can find it via either
 * the namespaced canonical name (`email_send`) or natural-language verb
 * forms (`send_email`). Only the canonical name's description appears
 * verbatim; aliases get a "(alias of <canonical>)" suffix so the model
 * understands they resolve to the same handler.
 *
 * Why aliases at all:
 *   LLMs hallucinate tool names from common-sense templates. When the
 *   user says "send an email", the model often emits `send_email` as
 *   the call. With no alias, that call fails with "tool not found" and
 *   the model has to retry. With the alias, it just works.
 *
 *   We pay a small cost in tool-list bloat (the names show up twice in
 *   the catalog) but accept it because the alternative — model retries
 *   on a wrong-name guess — costs more in latency and tokens per turn.
 *
 * Deprecation flow:
 *   When a tool is renamed (e.g. `anima_email_send` → `email_send`), pass
 *   the old names in `aliases` AND set `deprecate: true`. Aliases will:
 *     - Render with `[DEPRECATED — use <canonical>]` prefix in the
 *       tool description so any consumer browsing tools/list sees the
 *       migration path immediately.
 *     - Log a structured warning to stderr on every invocation so we can
 *       grep server logs for usage and decide when removal is safe.
 *     - Otherwise behave identically to the canonical (same handler).
 *
 *   Removing aliases without a deprecation window is a breaking change for
 *   every consumer that pinned to the old name in code, prompts, or docs.
 *   Always go through this helper for renames.
 */
// biome-ignore lint/suspicious/noExplicitAny: Mirrors McpServer.registerTool's overloaded signature; preserving stricter inference would require copying ~80 lines of generics from the SDK.
export function registerToolWithAliases(
	server: McpServer,
	canonical: string,
	aliases: readonly string[],
	config: {
		title?: string;
		description: string;
		// biome-ignore lint/suspicious/noExplicitAny: Zod-shape passthrough.
		inputSchema: any;
		annotations?: ToolAnnotations;
		deprecate?: boolean;
	},
	// biome-ignore lint/suspicious/noExplicitAny: Same.
	handler: any,
): void {
	server.registerTool(
		canonical,
		{
			...(config.title ? { title: config.title } : {}),
			description: config.description,
			inputSchema: config.inputSchema,
			...(config.annotations ? { annotations: config.annotations } : {}),
		},
		handler,
	);
	for (const alias of aliases) {
		const description = config.deprecate
			? `[DEPRECATED — use \`${canonical}\`] ${config.description} This alias is kept for backward compatibility and will be removed in a future release.`
			: `${config.description} (alias of \`${canonical}\`)`;

		// biome-ignore lint/suspicious/noExplicitAny: Handler signature passthrough.
		const wrappedHandler: any = config.deprecate
			? // biome-ignore lint/suspicious/noExplicitAny: Same.
				(...args: any[]) => {
					console.warn(
						`[deprecated-tool] alias "${alias}" was invoked — migrate callers to "${canonical}". The alias will be removed in a future release.`,
					);
					return handler(...args);
				}
			: handler;

		server.registerTool(
			alias,
			{
				description,
				inputSchema: config.inputSchema,
				...(config.annotations ? { annotations: config.annotations } : {}),
			},
			wrappedHandler,
		);
	}
}
