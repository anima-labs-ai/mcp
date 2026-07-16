export type MarketplaceMetadata = {
	name: string;
	description: string;
	version: string;
	author: string;
	tools: number;
	domains: string[];
	transport: string[];
	install: string;
};

/**
 * Mirrors ../marketplace.json (kept at the repo root for registry
 * listings). Inlined rather than imported: the npm tarball ships only
 * `dist/` (`files: ["dist"]`), so the compiled `import "../marketplace.json"`
 * resolved to a file that was never published — `npx @anima-labs/mcp@0.5.1`
 * crashed on startup with ERR_MODULE_NOT_FOUND. Bare JSON ESM imports also
 * require `with { type: "json" }` on modern Node, so even shipping the file
 * would not have been enough. `published-package.test.ts` boots the packed
 * tarball to keep this class of bug out of releases.
 */
export const marketplaceMetadata: MarketplaceMetadata = {
	name: "Anima MCP Server",
	description:
		"53 tools for AI agents — email, phone, sms, voice, vault, webhooks",
	version: "0.5.2",
	author: "Anima",
	tools: 53,
	domains: [
		"identity",
		"email",
		"phone",
		"sms",
		"voice",
		"messaging",
		"vault",
		"webhooks",
	],
	transport: ["stdio", "http"],
	install: "npx @anima-labs/mcp",
};
