#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, SERVER_INFO } from "./config.js";
import type { McpConfig } from "./config.js";
import { ApiClient, createApiClientFromEnv } from "./api-client.js";
import type { ToolRegistrationOptions } from "./tool-helpers.js";
import { registerAddressTools } from "./tools/address/index.js";
import { registerOrganizationTools } from "./tools/organization/index.js";
import { registerAgentTools } from "./tools/agent/index.js";
import { registerEmailTools } from "./tools/email/index.js";
import { registerDomainTools } from "./tools/domain/index.js";
import { registerPhoneTools } from "./tools/phone/index.js";
import { registerVaultTools } from "./tools/vault/index.js";
import { registerCardTools } from "./tools/cards/index.js";
import { registerFundingTools } from "./tools/funding/index.js";
import { registerMessageTools } from "./tools/message/index.js";
import { registerWebhookTools } from "./tools/webhook/index.js";
import { registerSecurityTools } from "./tools/security/index.js";
import { registerUtilityTools } from "./tools/utility/index.js";
import { registerBrowserPaymentsTools } from "./tools/browser-payments/index.js";
import { registerX402Tools } from "./tools/x402/index.js";
import { registerInvoiceTools } from "./tools/invoice/index.js";
import { registerResources } from "./resources/index.js";
import { cancelAllFollowUps } from "./pending-followup.js";
import { createMcpHttpServer, parseBearerToken, type McpAuthError, type McpAuthContext } from "./http-transport.js";
export { marketplaceMetadata } from "./marketplace.js";

const VALID_KEY_PREFIXES = ["ak_", "mk_", "sk_live_", "sk_test_"];

/** Map of tool group names to their registration functions */
const TOOL_GROUPS: Record<string, (options: ToolRegistrationOptions) => void> = {
	address: registerAddressTools,
	org: registerOrganizationTools,
	agent: registerAgentTools,
	email: registerEmailTools,
	domain: registerDomainTools,
	phone: registerPhoneTools,
	vault: registerVaultTools,
	cards: registerCardTools,
	funding: registerFundingTools,
	message: registerMessageTools,
	webhook: registerWebhookTools,
	security: registerSecurityTools,
	utility: registerUtilityTools,
	browser: registerBrowserPaymentsTools,
	x402: registerX402Tools,
	invoice: registerInvoiceTools,
};

/**
 * Parse --tools flag from command line args.
 * Returns null if not provided (register all), or a Set of group names.
 */
function parseToolGroups(args: string[] = process.argv): Set<string> | null {
	const toolsArg = args.find((a) => a.startsWith("--tools=") || a === "--tools");
	if (!toolsArg) return null;

	let value: string;
	if (toolsArg === "--tools") {
		const idx = args.indexOf(toolsArg);
		value = args[idx + 1] ?? "";
	} else {
		value = toolsArg.split("=")[1] ?? "";
	}

	if (!value) return null;

	const requested = new Set(value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
	const valid = new Set(Object.keys(TOOL_GROUPS));
	const invalid = [...requested].filter((g) => !valid.has(g));

	if (invalid.length > 0) {
		console.error(
			`Warning: Unknown tool group(s): ${invalid.join(", ")}. Valid groups: ${[...valid].join(", ")}`,
		);
	}

	return requested;
}

function createConfiguredServer(client: ApiClient, toolGroups?: Set<string> | null): McpServer {
	const server = new McpServer(SERVER_INFO, {
		capabilities: { tools: {}, resources: {} },
	});

	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};

	for (const [groupName, registrar] of Object.entries(TOOL_GROUPS)) {
		if (!toolGroups || toolGroups.has(groupName)) {
			registrar(context);
		}
	}

	registerResources(context);

	return server;
}

async function main() {
	const config = loadConfig();
	const toolGroups = parseToolGroups();

	if (toolGroups) {
		console.error(`Selective tool loading: ${[...toolGroups].join(", ")}`);
	}

	if (config.httpMode) {
		await startHttpServer(config, toolGroups);
	} else {
		const client = createApiClientFromEnv();
		await startStdioServer(createConfiguredServer(client, toolGroups));
	}
}

async function startStdioServer(server: McpServer) {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Anima MCP server running on stdio");

	const shutdown = async () => {
		console.error("Shutting down...");
		cancelAllFollowUps();
		await server.close();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

async function startHttpServer(config: McpConfig, toolGroups?: Set<string> | null) {
	// Per-session auth: authenticate stores the validated client, factory reads it.
	// The authenticate→factory sequence is synchronous within a single HTTP request,
	// so this closure pattern is safe (no race between authenticate and factory).
	let pendingClient: ApiClient | null = null;

	const { httpServer, close } = createMcpHttpServer(
		() => {
			if (!pendingClient) {
				throw new Error("No authenticated client available — authenticate must run before factory");
			}
			const client = pendingClient;
			pendingClient = null;
			return createConfiguredServer(client, toolGroups);
		},
		{
			port: config.httpPort,
			onShutdown: () => cancelAllFollowUps(),
		authenticate: async (req): Promise<McpAuthContext> => {
			const token = parseBearerToken(req);
			if (!token) {
				const err: McpAuthError = { status: 401, message: "Missing Authorization header. Use: Bearer <api-key>" };
				throw err;
			}

			const hasValidPrefix = VALID_KEY_PREFIXES.some((p) => token.startsWith(p));
			if (!hasValidPrefix) {
				const err: McpAuthError = {
					status: 401,
					message: `Invalid API key format. Key must start with one of: ${VALID_KEY_PREFIXES.join(", ")}`,
				};
				throw err;
			}

			const client = new ApiClient({
				baseUrl: config.apiUrl,
				apiKey: token,
			});

			let orgId = "default";
			try {
				const orgsResponse = await client.get("/organizations");
				const firstOrg = Array.isArray(orgsResponse) ? orgsResponse[0] : undefined;
				if (firstOrg?.id) {
					orgId = firstOrg.id;
				}
			} catch (apiErr) {
				const err: McpAuthError = { status: 401, message: "Invalid or expired API key" };
				throw err;
			}

			pendingClient = client;
			return { apiKeyId: token, orgId };
		},
		},
	);

	const port = config.httpPort;
	httpServer.listen(port, () => {
		console.error(`Anima MCP server running on http://localhost:${port}/mcp`);
	});

	const shutdown = async () => {
		console.error("Shutting down HTTP server...");
		cancelAllFollowUps();
		await close();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
