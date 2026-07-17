#!/usr/bin/env bun
/**
 * Regenerate the contract-route manifest that the M2/M3 CI gates assert against.
 *
 * WHY A COMMITTED MANIFEST RATHER THAN A LIVE IMPORT:
 * `@anima/contracts` is `private: true` and lives in the PRIVATE anima
 * monorepo; this repo is PUBLIC and has no monorepo access token. So CI
 * cannot import the contracts directly the way the CLI does (the CLI is
 * private and holds an ANIMA_REPO_TOKEN). Instead we snapshot the route
 * surface — HTTP method, path template, and input-property NAMES — which is
 * already public API surface (it is published as docs/openapi.json and on
 * docs.useanima.sh). No schema internals, no private source, are copied.
 *
 * The snapshot pins the anima commit it was generated from (`_meta.animaRef`),
 * mirroring the CLI's `.anima-ref` convention. It catches the rot that exists
 * at generation time (fictional routes/params). Detecting drift introduced by
 * LATER anima merges needs a scheduled canary with repo access — that is
 * spec item C12, and it can shell out to this same script.
 *
 * Usage:
 *   bun run scripts/generate-contract-manifest.ts --anima ../../anima
 *   bun run scripts/generate-contract-manifest.ts --anima /abs/path/to/anima --check
 *
 * `--check` regenerates in memory and diffs against the committed manifest
 * without writing (exit 1 on drift) — the shape a canary wants.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"__tests__",
	"fixtures",
	"contract-routes.json",
);

interface Manifest {
	_meta: {
		animaRef: string;
		source: string;
		note: string;
	};
	/** "METHOD /path/{param}" -> sorted input property names */
	routes: Record<string, string[]>;
}

function parseArgs(argv: string[]): { animaPath: string; check: boolean } {
	const animaIdx = argv.indexOf("--anima");
	if (animaIdx === -1 || !argv[animaIdx + 1]) {
		console.error(
			"error: --anima <path-to-anima-monorepo> is required\n" +
				"example: bun run scripts/generate-contract-manifest.ts --anima ../../anima",
		);
		process.exit(2);
	}
	return { animaPath: resolve(argv[animaIdx + 1]), check: argv.includes("--check") };
}

/** Unwrap the Zod wrappers a contract input may be declared with. */
function unwrapZod(schema: unknown): unknown {
	let current = schema as { _def?: { typeName?: string; schema?: unknown; innerType?: unknown } };
	// Bounded: guards against a cyclic _def chain.
	for (let i = 0; i < 10; i++) {
		const def = current?._def;
		if (!def) return current;
		const inner = def.schema ?? def.innerType;
		if (!inner) return current;
		current = inner as typeof current;
	}
	return current;
}

/** Property names of a contract procedure's input schema, or [] if not an object schema. */
function inputPropertyNames(inputSchema: unknown): string[] {
	if (!inputSchema) return [];
	const unwrapped = unwrapZod(inputSchema) as { shape?: Record<string, unknown> };
	const shape = unwrapped?.shape;
	if (!shape || typeof shape !== "object") return [];
	return Object.keys(shape).sort();
}

interface OrpcLeaf {
	route?: { method?: string; path?: string };
	inputSchema?: unknown;
	prefix?: string;
}

/** Recursively collect every contract procedure into "METHOD /path" -> props. */
function collectRoutes(node: unknown, routes: Record<string, string[]> = {}): Record<string, string[]> {
	if (!node || typeof node !== "object") return routes;

	const leaf = (node as Record<string, unknown>)["~orpc"] as OrpcLeaf | undefined;
	if (leaf?.route?.method && leaf.route.path) {
		// oRPC prefixes are applied via `.prefix()` on a router; fold it in so
		// the manifest holds the real wire path.
		const path = `${leaf.prefix ?? ""}${leaf.route.path}`;
		routes[`${leaf.route.method} ${path}`] = inputPropertyNames(leaf.inputSchema);
		return routes;
	}

	for (const value of Object.values(node as Record<string, unknown>)) {
		collectRoutes(value, routes);
	}
	return routes;
}

function animaHeadSha(animaPath: string): string {
	try {
		return execFileSync("git", ["-C", animaPath, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown";
	}
}

async function main(): Promise<void> {
	const { animaPath, check } = parseArgs(process.argv.slice(2));
	const contractsEntry = join(animaPath, "packages", "contracts", "src", "index.ts");

	let contract: unknown;
	try {
		({ contract } = (await import(contractsEntry)) as { contract: unknown });
	} catch (error) {
		console.error(
			`error: could not import contracts from ${contractsEntry}\n` +
				`Is --anima pointing at an anima monorepo checkout?\n${String(error)}`,
		);
		process.exit(2);
	}

	const routes = collectRoutes(contract);
	const routeCount = Object.keys(routes).length;
	if (routeCount === 0) {
		console.error("error: zero routes collected — contract shape changed; fix this script.");
		process.exit(2);
	}

	const manifest: Manifest = {
		_meta: {
			animaRef: animaHeadSha(animaPath),
			source: "anima/packages/contracts (@anima/contracts)",
			note:
				"GENERATED by scripts/generate-contract-manifest.ts — do not hand-edit. " +
				"Public REST surface only (method, path, input property names).",
		},
		// Sort for a stable, reviewable diff.
		routes: Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))),
	};

	const serialized = `${JSON.stringify(manifest, null, "\t")}\n`;

	if (check) {
		const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
		const drift = Object.keys({ ...committed.routes, ...routes }).filter(
			(key) =>
				JSON.stringify(committed.routes[key]) !== JSON.stringify(routes[key]),
		);
		if (drift.length > 0) {
			console.error(`contract drift vs committed manifest (${drift.length} route(s)):`);
			for (const key of drift) {
				console.error(
					`  ${key}\n    committed: ${JSON.stringify(committed.routes[key] ?? null)}\n    anima:     ${JSON.stringify(routes[key] ?? null)}`,
				);
			}
			process.exit(1);
		}
		console.log(`no drift — ${routeCount} routes match the committed manifest.`);
		return;
	}

	writeFileSync(MANIFEST_PATH, serialized);
	console.log(`wrote ${routeCount} routes to ${MANIFEST_PATH}`);
	console.log(`anima ref: ${manifest._meta.animaRef}`);
}

await main();
