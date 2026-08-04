/**
 * M2 + M3 — the gates that make a tool's advertised surface answerable to the
 * real API contract.
 *
 * These do NOT test that the bridge "works". They test that it cannot LIE:
 *
 *   M2  A tool must call a route that exists. Tools shipped ahead of (or behind)
 *       the API return 404s the LLM cannot recover from, and no unit test that
 *       mocks the client can see it. This is what let fictional `sms_thread_*`
 *       tools ship in the hosted MCP.
 *
 *   M3  A tool must not advertise a parameter its backing route ignores. oRPC
 *       Zod-STRIPS unknown input, so the server happily returns 200 and the LLM
 *       believes its filter was honoured. `email_list.folder` / `.offset` were
 *       exactly this: an LLM asking for the "sent" folder silently got the inbox.
 *
 * Ground truth is `fixtures/contract-routes.json`, snapshotted from the private
 * `@anima/contracts` (see scripts/generate-contract-manifest.ts). Declarations
 * live in `src/tool-routes.ts`.
 *
 * If a change here fails: fix the TOOL. Editing the declaration to match a lie —
 * or dumping a param into `clientParams` — re-opens the exact hole these gates exist
 * to close.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../../api-client.js";
import type {
	ToolContext,
	ToolRegistrationOptions,
} from "../../tool-helpers.js";
import { TOOL_CONTRACTS } from "../../tool-routes.js";
import { registerAgentTools } from "../../tools/agent/index.js";
import { registerDomainTools } from "../../tools/domain/index.js";
import { registerEmailTools } from "../../tools/email/index.js";
import { registerPhoneTools } from "../../tools/phone/index.js";
import { registerPhoneCallTools } from "../../tools/phone_call/index.js";
import { registerProvisioningTools } from "../../tools/provisioning/index.js";
import { registerSmsTools } from "../../tools/sms/index.js";
import { registerVaultTools } from "../../tools/vault/index.js";
import { registerWebhookTools } from "../../tools/webhook/index.js";
import { registerWorkspaceTools } from "../../tools/workspace/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(HERE, "..", "..", "tools");

interface ContractManifest {
	_meta: { animaRef: string };
	routes: Record<string, string[]>;
}

const manifest = JSON.parse(
	readFileSync(join(HERE, "..", "fixtures", "contract-routes.json"), "utf8"),
) as ContractManifest;

/** Register every tool group against a recording stub, capturing name -> input props. */
function registerAllTools(): Map<string, string[]> {
	const tools = new Map<string, string[]>();
	const server = {
		tool: (name: string, _d: string, schema: Record<string, unknown>) => {
			tools.set(name, Object.keys(schema ?? {}).sort());
		},
		registerTool: (
			name: string,
			config: { inputSchema?: Record<string, unknown> },
		) => {
			tools.set(name, Object.keys(config.inputSchema ?? {}).sort());
		},
		resource: () => {},
	} as unknown as McpServer;

	const context: ToolContext = {
		// Never called: registration must not touch the network.
		client: {} as ApiClient,
		hasMasterKey: true,
	};
	const options: ToolRegistrationOptions = { server, context };

	for (const register of [
		registerAgentTools,
		registerDomainTools,
		registerEmailTools,
		registerPhoneTools,
		registerPhoneCallTools,
		registerProvisioningTools,
		registerSmsTools,
		registerVaultTools,
		registerWebhookTools,
		registerWorkspaceTools,
	]) {
		register(options);
	}
	return tools;
}

const registeredTools = registerAllTools();

/** Path placeholders are positional on the wire: /voice/calls/{callId} and
 *  /voice/calls/{id} are the same URL. Compare shapes, not placeholder names. */
function normalizePath(path: string): string {
	return path.replace(/\{[^}]*\}/g, "{}");
}

/** Contract input properties reachable across all of a tool's declared routes. */
function contractPropsFor(routes: readonly string[]): Set<string> {
	const props = new Set<string>();
	for (const route of routes) {
		for (const prop of manifest.routes[route] ?? []) props.add(prop);
	}
	return props;
}

function walkTs(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walkTs(full, out);
		else if (full.endsWith(".ts")) out.push(full);
	}
	return out;
}

describe("M2 — every tool maps to a live contract route", () => {
	test("the manifest itself is populated and pinned to an anima commit", () => {
		// A silently-empty manifest would make every assertion below vacuous.
		expect(Object.keys(manifest.routes).length).toBeGreaterThan(100);
		expect(manifest._meta.animaRef).toMatch(/^[0-9a-f]{40}$/);
	});

	test("every registered tool declares its backing routes", () => {
		const undeclared = [...registeredTools.keys()].filter(
			(name) => !TOOL_CONTRACTS[name],
		);
		expect(undeclared).toEqual([]);
	});

	test("no declaration outlives the tool it describes", () => {
		const orphaned = Object.keys(TOOL_CONTRACTS).filter(
			(name) => !registeredTools.has(name),
		);
		expect(orphaned).toEqual([]);
	});

	test("every declared route exists in the API contract", () => {
		// The gate proper: a tool pointing at a route the API never had (or no
		// longer has) fails here instead of 404-ing an agent in production.
		const fictional: string[] = [];
		for (const [tool, decl] of Object.entries(TOOL_CONTRACTS)) {
			for (const route of decl.routes) {
				if (!manifest.routes[route]) fictional.push(`${tool} -> ${route}`);
			}
		}
		expect(fictional).toEqual([]);
	});

	test("every route a tool actually calls is one it declared", () => {
		// Without this, the declarations are just a second list that can drift from
		// the code they claim to describe. Scans the real call sites so a tool
		// cannot declare `GET /email` while calling `/v1/made-up`.
		const declaredShapes = new Set(
			Object.values(TOOL_CONTRACTS).flatMap((decl) =>
				decl.routes.map((route) => normalizePath(route.split(" ")[1])),
			),
		);

		const undeclaredCalls: string[] = [];
		for (const file of walkTs(TOOLS_DIR)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/["'`](\/v1\/[^"'`]*)["'`]/g)) {
				const shape = normalizePath(
					match[1].replace(/\$\{[^}]*\}/g, "{}").split("?")[0],
				).replace(/^\/v1/, "");
				if (!declaredShapes.has(shape)) {
					undeclaredCalls.push(
						`${file.replace(TOOLS_DIR, "tools")}: ${match[1]}`,
					);
				}
			}
		}
		expect(undeclaredCalls).toEqual([]);
	});

	test("tools call the API under its /v1 mount prefix", () => {
		// The API serves every contract route under one /v1 prefix while the
		// contracts themselves are bare, and the client's base URL carries no
		// prefix. A bare path is therefore an instant 404 — the bug that made the
		// published anima://inbox resource dead on arrival.
		const barePaths: string[] = [];
		for (const file of walkTs(TOOLS_DIR)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(
				/client\.(?:get|post|patch|put|delete)(?:<[^>]*>)?\(\s*["'`](\/[^"'`]*)["'`]/g,
			)) {
				if (!match[1].startsWith("/v1/"))
					barePaths.push(`${file}: ${match[1]}`);
			}
		}
		expect(barePaths).toEqual([]);
	});
});

describe("M3 — tool params are a subset of the backing contract schema", () => {
	test("no tool advertises a parameter its routes ignore", () => {
		// The folder/offset class: Zod-strip means the server 200s and the LLM
		// never learns its filter was dropped.
		const fictionalParams: string[] = [];

		for (const [tool, props] of registeredTools) {
			const decl = TOOL_CONTRACTS[tool];
			if (!decl) continue; // covered by M2

			const allowed = contractPropsFor(decl.routes);
			for (const key of Object.keys(decl.paramAliases ?? {})) allowed.add(key);
			for (const key of Object.keys(decl.clientParams ?? {})) allowed.add(key);

			for (const prop of props) {
				if (!allowed.has(prop)) fictionalParams.push(`${tool}.${prop}`);
			}
		}

		expect(fictionalParams).toEqual([]);
	});

	test("an alias must resolve to a param the contract really has", () => {
		// The teeth of the aliasing escape hatch. `status -> state` is fine because
		// the route has `state`. `numberId -> phoneIdentityId` is NOT fine, and must
		// not be waved through just because the tool renames it on the way out.
		const broken: string[] = [];
		for (const [tool, decl] of Object.entries(TOOL_CONTRACTS)) {
			const props = registeredTools.get(tool) ?? [];
			const contractProps = contractPropsFor(decl.routes);
			for (const [toolParam, contractParam] of Object.entries(
				decl.paramAliases ?? {},
			)) {
				if (!props.includes(toolParam)) {
					broken.push(
						`${tool}.paramAliases: '${toolParam}' is not a param of this tool`,
					);
				}
				if (!contractProps.has(contractParam)) {
					broken.push(
						`${tool}.paramAliases: '${toolParam}' -> '${contractParam}', but no declared route accepts '${contractParam}'`,
					);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	test("clientParams holds only params that are real, and really client-side", () => {
		// Keeps the escape hatch honest: an entry that is actually a contract param
		// is a mislabel, and an entry for a param the tool no longer has is dead
		// config that would mask a future fictional param of the same name.
		const problems: string[] = [];
		for (const [tool, decl] of Object.entries(TOOL_CONTRACTS)) {
			const props = registeredTools.get(tool) ?? [];
			const contractProps = contractPropsFor(decl.routes);
			for (const [param, reason] of Object.entries(decl.clientParams ?? {})) {
				if (!props.includes(param)) {
					problems.push(
						`${tool}.clientParams: '${param}' is not a param of this tool`,
					);
				}
				if (contractProps.has(param)) {
					problems.push(
						`${tool}.clientParams: '${param}' IS a contract param — remove the exemption`,
					);
				}
				if (reason.trim().length < 15) {
					problems.push(`${tool}.clientParams: '${param}' needs a real reason`);
				}
			}
		}
		expect(problems).toEqual([]);
	});
});
