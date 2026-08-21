import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildManifest, extractTools } from "../../../scripts/build-mcpb-manifest";

/**
 * WHY: the previous desktop bundle was hand-maintained and drifted into
 * fiction — 29 advertised tools, six of them `*_pod` operations this platform
 * has never had, wrapped around a 158-line server that never imported the
 * published package. It also validated cleanly against the MCPB schema the
 * whole time, which is the point: a manifest can be structurally perfect and
 * factually invented. Only generation from the registry prevents that, and
 * only a diff test keeps the generated file honest once checked in.
 */
const repoRoot = join(import.meta.dir, "..", "..", "..");
const manifestPath = join(repoRoot, "mcpb", "manifest.json");

function checkedIn(): Record<string, unknown> {
	return JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
}

describe("mcpb manifest", () => {
	it("matches a fresh generation from the tool registry", () => {
		// The failure this catches: someone adds a tool and ships a bundle that
		// does not list it, or edits the manifest by hand and it silently stops
		// describing the code. Run `bun run gen:mcpb` to fix.
		expect(checkedIn()).toEqual(buildManifest());
	});

	it("passes the official MCPB schema validator", () => {
		// Runs the vendored CLI, not npx: a test that needs the network is a
		// test that fails for reasons unrelated to the code.
		const result = Bun.spawnSync([
			join(repoRoot, "node_modules", ".bin", "mcpb"),
			"validate",
			manifestPath,
		]);
		const output = `${result.stdout.toString()}${result.stderr.toString()}`;

		expect(output).toContain("Manifest schema validation passes!");
		expect(result.exitCode).toBe(0);
	});

	it("advertises exactly the tools the package registers", () => {
		const tools = checkedIn().tools as { name: string }[];
		const registered = extractTools().map((t) => t.name);

		expect(tools.map((t) => t.name)).toEqual(registered);
	});

	it("agrees with smithery.yaml on the tool count", () => {
		// Two manifests describing one package is how the last drift happened.
		// They are generated and hand-written respectively, so pin them together.
		const smithery = readFileSync(join(repoRoot, "smithery.yaml"), "utf-8");
		const claimed = Number(/(\d+) tools/.exec(smithery)?.[1]);

		expect((checkedIn().tools as unknown[]).length).toBe(claimed);
	});

	it("does not map ANIMA_API_URL into the bundle env", () => {
		// api-client.ts reads it with `??`, which does not catch an empty
		// string. If a user clears the field, the base URL becomes "" and every
		// call breaks. Leaving it unmapped lets the code's own default apply.
		const env = (
			(checkedIn().server as { mcp_config: { env: Record<string, string> } }).mcp_config
		).env;

		expect(Object.hasOwn(env, "ANIMA_API_URL")).toBe(false);
		expect(env.ANIMA_API_KEY).toBe("${user_config.api_key}");
	});
});
