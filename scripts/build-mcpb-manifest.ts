/**
 * Generates mcpb/manifest.json from the real tool registry.
 *
 * WHY this is generated rather than hand-written: the previous desktop bundle
 * was hand-maintained and drifted into fiction — it advertised 29 tools, six of
 * them `*_pod` operations this platform has never had, wrapped around a
 * 158-line server that did not import the published package at all. A manifest
 * nobody derives from the code is a manifest that describes the product its
 * author remembered.
 *
 * Run: bun run gen:mcpb
 * Guarded by: src/__tests__/unit/mcpb-manifest.test.ts (regenerates and diffs)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const toolsDir = join(repoRoot, "src", "tools");

interface ToolEntry {
	name: string;
	description: string;
}

/**
 * Pulls `registerTool("name", { description: "..." })` pairs out of each tool
 * group. Same extraction the Smithery manifest test uses, so the two manifests
 * cannot disagree about what this package registers.
 */
export function extractTools(): ToolEntry[] {
	const tools: ToolEntry[] = [];
	for (const group of readdirSync(toolsDir).sort()) {
		const source = readFileSync(join(toolsDir, group, "index.ts"), "utf-8");
		const pattern =
			/registerTool\(\s*\n?\s*"([a-z0-9_]+)"\s*,\s*\{\s*\n?\s*description:\s*\n?\s*("(?:[^"\\]|\\.)*")/g;
		for (const match of source.matchAll(pattern)) {
			// The registry descriptions are multi-sentence guidance written for a
			// model choosing a tool. A bundle listing shows one line, so take the
			// first sentence rather than truncating mid-word.
			const full = JSON.parse(match[2] as string) as string;
			tools.push({
				name: match[1] as string,
				description: full.split(/(?<=\.)\s/)[0] as string,
			});
		}
	}
	return tools.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildManifest(): Record<string, unknown> {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
		version: string;
	};
	const tools = extractTools();

	return {
		manifest_version: "0.3",
		name: "anima-mcp",
		display_name: "Anima — AI Agent Identity Platform",
		version: pkg.version,
		description: `Give your AI agents real-world capabilities: email inboxes, phone numbers, SMS, voice calls, custom domains, webhooks, and an encrypted credential vault. ${tools.length} tools for autonomous agent operations.`,
		author: { name: "Anima Labs", url: "https://useanima.sh" },
		homepage: "https://useanima.sh",
		documentation: "https://docs.useanima.sh",
		repository: { type: "git", url: "https://github.com/anima-labs-ai/mcp" },
		license: "MIT",
		icon: "icon.png",
		keywords: ["ai-agent", "email", "voice", "phone", "sms", "vault", "identity", "webhook"],
		server: {
			type: "node",
			entry_point: "dist/index.js",
			mcp_config: {
				command: "node",
				args: ["${__dirname}/dist/index.js"],
				// ANIMA_API_URL is deliberately NOT mapped. api-client.ts reads it
				// with `??`, which does not catch an empty string, so a blank value
				// would set the base URL to "" and break every call. Leaving it
				// unset lets the code's own default (https://api.useanima.sh) apply,
				// which is what a desktop install wants anyway.
				//
				// ANIMA_MASTER_KEY is safe to map even when the user leaves it
				// blank: it is consumed via truthiness (`!!this.masterKey`), so an
				// empty string behaves exactly as absent.
				env: {
					ANIMA_API_KEY: "${user_config.api_key}",
					ANIMA_MASTER_KEY: "${user_config.master_key}",
				},
			},
		},
		tools,
		user_config: {
			api_key: {
				type: "string",
				title: "API Key",
				description:
					"Your Anima agent API key (ak_...). Create one at https://console.useanima.sh, or run `am init`.",
				required: true,
				sensitive: true,
			},
			master_key: {
				type: "string",
				title: "Master Key (optional)",
				description:
					"Org master key (mk_...). Only needed for admin tools such as agent_delete and domain management. Leave blank otherwise.",
				required: false,
				sensitive: true,
			},
		},
	};
}

if (import.meta.main) {
	const manifest = buildManifest();
	const out = join(repoRoot, "mcpb", "manifest.json");
	writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`wrote ${out} (${(manifest.tools as ToolEntry[]).length} tools)`);
}
