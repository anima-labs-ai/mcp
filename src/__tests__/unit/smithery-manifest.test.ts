import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * WHY: the Smithery manifest is a public registry listing. A previous
 * version advertised "153 tools" with invented names and whole invented
 * groups (x402, wallet, pods, registry, "USPS validation") — none of which
 * this package registers (competitive-parity spec E4). These tests pin the
 * manifest to the REAL registered tool surface so listing drift cannot
 * ship again: they extract tool names from `registerTool("name")` calls in
 * src/tools/** and require the manifest's tool set to match exactly.
 */

const repoRoot = join(import.meta.dir, "..", "..", "..");
const manifestPath = join(repoRoot, "smithery.yaml");
const toolsDir = join(repoRoot, "src", "tools");

function extractRegisteredToolNames(): Set<string> {
	const names = new Set<string>();
	const groups = readdirSync(toolsDir);
	for (const group of groups) {
		const indexPath = join(toolsDir, group, "index.ts");
		const source = readFileSync(indexPath, "utf-8");
		// Matches: server.registerTool(\n  "tool_name",
		const matches = source.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g);
		for (const match of matches) {
			names.add(match[1] as string);
		}
	}
	return names;
}

function extractManifestToolNames(): { all: Set<string>; byLine: string[] } {
	const manifest = readFileSync(manifestPath, "utf-8");
	const all = new Set<string>();
	const byLine: string[] = [];
	// tools: ["a", "b", ...] lines within tool_groups
	const matches = manifest.matchAll(/tools:\s*\[([^\]]*)\]/g);
	for (const match of matches) {
		for (const raw of (match[1] as string).split(",")) {
			const name = raw.trim().replace(/^"|"$/g, "");
			if (name) {
				all.add(name);
				byLine.push(name);
			}
		}
	}
	return { all, byLine };
}

describe("smithery.yaml manifest truth", () => {
	it("lists exactly the tools this package registers — no phantoms, no omissions", () => {
		const registered = extractRegisteredToolNames();
		const manifest = extractManifestToolNames();

		const phantoms = [...manifest.all].filter((name) => !registered.has(name));
		const missing = [...registered].filter((name) => !manifest.all.has(name));

		expect(phantoms).toEqual([]);
		expect(missing).toEqual([]);
	});

	it("has no duplicate tool entries", () => {
		const manifest = extractManifestToolNames();
		expect(manifest.byLine.length).toBe(manifest.all.size);
	});

	it("advertises the real tool count in the description", () => {
		const registered = extractRegisteredToolNames();
		const manifest = readFileSync(manifestPath, "utf-8");
		const countClaim = manifest.match(/(\d+) tools/);
		expect(countClaim).not.toBeNull();
		expect(Number((countClaim as RegExpMatchArray)[1])).toBe(registered.size);
	});

	it("matches the package.json version", () => {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
			version: string;
		};
		const manifest = readFileSync(manifestPath, "utf-8");
		expect(manifest).toContain(`version: "${pkg.version}"`);
	});

	it("never re-lists excluded/removed feature groups", () => {
		const manifest = readFileSync(manifestPath, "utf-8").toLowerCase();
		for (const banned of ["x402", "wallet", "pod", "usps", "agent-to-agent messaging"]) {
			// The explanatory header comment may name them; group/tool entries must not.
			const body = manifest.slice(manifest.indexOf("name:"));
			expect(body.includes(`name: "${banned}`)).toBe(false);
			expect(body.includes(`${banned}_`)).toBe(false);
		}
	});
});
