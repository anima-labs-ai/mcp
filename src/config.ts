/**
 * MCP Server Configuration
 *
 * Environment-based configuration and constants for the MCP server.
 */

/** Tool names that require master key access */
export const MASTER_KEY_TOOLS = new Set([
	"org_create",
	"org_delete",
	"org_rotate_key",
	"agent_delete",
	"agent_rotate_key",
	"domain_add",
	"domain_delete",
	"domain_verify",
	"webhook_delete",
	"security_update_policy",
]);

/** Server metadata */
export const SERVER_INFO = {
	name: "anima-mcp",
	version: "2.0.0",
	description:
		"Anima MCP Server — Unified email, phone, SMS & voice identity infrastructure for AI agents",
} as const;

/** Default configuration values */
export const DEFAULTS = {
	apiUrl: "http://127.0.0.1:3100",
	mcpPort: 8014,
	requestTimeoutMs: 30_000,
	maxListLimit: 100,
	defaultListLimit: 20,
} as const;

/** Configuration loaded from environment */
export interface McpConfig {
	apiUrl: string;
	apiKey: string;
	masterKey?: string;
	httpMode: boolean;
	httpPort: number;
}

/** Load MCP configuration from environment variables */
export function loadConfig(args: string[] = process.argv): McpConfig {
	const httpMode = args.includes("--http");
	const portArg = args.find((a) => a.startsWith("--port="));
	const httpPort = portArg
		? Number.parseInt(portArg.split("=")[1], 10)
		: Number.parseInt(
				process.env.MCP_PORT ?? String(DEFAULTS.mcpPort),
				10,
			);

	return {
		apiUrl: process.env.ANIMA_API_URL ?? DEFAULTS.apiUrl,
		apiKey: process.env.ANIMA_API_KEY ?? "",
		masterKey: process.env.ANIMA_MASTER_KEY,
		httpMode,
		httpPort,
	};
}
