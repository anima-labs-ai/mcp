/**
 * C8 — the published `anima://inbox` / `anima://agent-info` resources must
 * actually READ.
 *
 * Both shipped calling bare paths ("/email?limit=20", "/orgs/me", "/agents")
 * while the API mounts every route under /v1 and the client's base URL carries
 * no prefix — so every read 404'd, in every published version, for every user.
 * The /v1 repair landed on the tools and missed the resources.
 *
 * It survived because the only resource test asserted that the resources
 * REGISTERED. Registration was never the broken part. These tests invoke the
 * handlers and assert the URL that goes out — the thing that was wrong.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../../api-client.js";
import type { ToolContext } from "../../tool-helpers.js";
import { registerResources } from "../../resources/index.js";

interface ContractManifest {
	routes: Record<string, string[]>;
}
const manifest = JSON.parse(
	readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "contract-routes.json"),
		"utf8",
	),
) as ContractManifest;

type ResourceHandler = (uri: URL) => Promise<{
	contents: Array<{ uri: string; text: string; mimeType: string }>;
}>;

/** Registers the resources against a stub client that records every path read. */
function harness(responses: Record<string, unknown> = {}) {
	const requested: string[] = [];
	const resources = new Map<string, ResourceHandler>();

	const client = {
		get: async (path: string) => {
			requested.push(path);
			return responses[path] ?? { items: [] };
		},
	} as unknown as ApiClient;

	const server = {
		resource: (name: string, _uri: unknown, _meta: unknown, handler: ResourceHandler) => {
			resources.set(name, handler);
		},
	} as unknown as McpServer;

	const context: ToolContext = { client, hasMasterKey: false };
	registerResources({ server, context });

	return { requested, resources };
}

describe("C8 — resources read from the API's /v1 mount", () => {
	test("anima://inbox reads emails from a path the API actually serves", async () => {
		const { requested, resources } = harness();

		await resources.get("Agent Inbox")?.(new URL("anima://inbox"));

		// The whole bug in one assertion: a bare "/email?limit=20" is a 404.
		expect(requested).toEqual(["/v1/email?limit=20"]);
	});

	test("anima://agent-info reads org + agents from paths the API actually serves", async () => {
		const { requested, resources } = harness({
			"/v1/orgs/me": { id: "org_1", name: "Acme" },
			"/v1/agents": { items: [{ id: "agent_1", name: "Ada" }] },
		});

		await resources.get("Agent Identity")?.(new URL("anima://agent-info"));

		expect(requested).toEqual(["/v1/orgs/me", "/v1/agents"]);
	});

	test("every path the resources read maps to a real contract route", async () => {
		// Same guarantee M2 gives the tools: pointing a resource at a route that
		// does not exist should fail here, not in a user's client.
		const { requested, resources } = harness({
			"/v1/orgs/me": {},
			"/v1/agents": { items: [] },
		});

		for (const handler of resources.values()) {
			await handler(new URL("anima://x"));
		}
		expect(requested.length).toBeGreaterThan(0);

		const unmapped = requested.filter((path) => {
			const contractPath = path.replace(/^\/v1/, "").split("?")[0];
			return !manifest.routes[`GET ${contractPath}`];
		});
		expect(unmapped).toEqual([]);
	});

	test("inbox renders the emails it read, rather than reporting an empty inbox", async () => {
		// Guards the failure the 404 produced in practice: the error surfaced to
		// the user as a plausible, wrong "No recent emails found."
		const { resources } = harness({
			"/v1/email?limit=20": {
				items: [
					{
						fromAddress: "ada@example.com",
						subject: "Invoice #42",
						createdAt: "2026-07-17T10:00:00Z",
					},
				],
			},
		});

		const result = await resources.get("Agent Inbox")?.(new URL("anima://inbox"));
		const text = result?.contents[0]?.text ?? "";

		expect(text).toContain("ada@example.com");
		expect(text).toContain("Invoice #42");
		expect(text).not.toContain("No recent emails found.");
	});
});
