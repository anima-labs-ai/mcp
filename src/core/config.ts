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

/** Server metadata (not `as const` — MCP SDK expects mutable icon arrays) */
export const SERVER_INFO = {
	name: "anima-mcp",
	version: "2.0.0",
	description:
		"Anima MCP Server — Unified email, phone, SMS & voice identity infrastructure for AI agents",
	icons: [
		{
			src: "https://console.useanima.sh/icon-512.png",
			mimeType: "image/png",
			sizes: ["512x512"],
		},
		{
			src: "https://console.useanima.sh/icon-192.png",
			mimeType: "image/png",
			sizes: ["192x192"],
		},
		{
			src: "https://console.useanima.sh/favicon-96.png",
			mimeType: "image/png",
			sizes: ["96x96"],
		},
	],
};

/** Default configuration values */
export const DEFAULTS = {
	apiUrl: "https://api.useanima.sh",
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

/** Load MCP configuration from environment variables and CLI args.
 *  Cloud Run sets PORT env var — when present, auto-enables HTTP mode. */
export function loadConfig(args: string[] = process.argv): McpConfig {
	const portEnv = process.env.PORT ?? process.env.MCP_PORT;
	const portArg = args.find((a) => a.startsWith("--port="));

	const httpPort = portArg
		? Number.parseInt(portArg.split("=")[1], 10)
		: portEnv
			? Number.parseInt(portEnv, 10)
			: DEFAULTS.mcpPort;

	// Auto-enable HTTP mode when PORT is set (Cloud Run convention) or --http flag
	const httpMode = args.includes("--http") || !!process.env.PORT;

	return {
		apiUrl: process.env.ANIMA_API_URL ?? DEFAULTS.apiUrl,
		apiKey: process.env.ANIMA_API_KEY ?? "",
		masterKey: process.env.ANIMA_MASTER_KEY,
		httpMode,
		httpPort,
	};
}
