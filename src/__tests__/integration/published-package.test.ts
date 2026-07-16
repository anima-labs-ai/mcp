/**
 * Boots the ACTUAL npm artifact — `npm pack` output, run with `node` — and
 * drives an MCP initialize/tools-list handshake over stdio.
 *
 * Why this exists: CI's build check used `bun build --target bun`, but the
 * published package is produced by `tsc` (prepublishOnly) and executed by
 * Node on user machines. The two never met in CI, so @anima-labs/mcp@0.5.1
 * shipped a `dist/marketplace.js` importing `../marketplace.json` — a file
 * excluded by `files: ["dist"]` — and every `npx @anima-labs/mcp` crashed at
 * startup with ERR_MODULE_NOT_FOUND. This test fails on that whole class:
 * imports of unpublished files, JSON-import-attribute errors, broken
 * shebang, or anything else that keeps the shipped tarball from serving
 * tools.
 */
import { describe, test, expect } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");

function packTarball(destDir: string): string {
	// prepublishOnly does NOT run on `npm pack`, so build explicitly first —
	// this is the same tsc output `npm publish` ships.
	execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
	execFileSync("npm", ["pack", "--pack-destination", destDir], {
		cwd: repoRoot,
		stdio: "pipe",
	});
	const tarball = readdirSync(destDir).find((f) => f.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack produced no tarball");
	execFileSync("tar", ["-xzf", join(destDir, tarball)], { cwd: destDir });
	return join(destDir, "package");
}

async function driveStdioHandshake(
	pkgDir: string,
): Promise<{ serverName: string; toolNames: string[] }> {
	// The extracted tarball has no node_modules; resolve dependencies through
	// the repo's install (same versions the lockfile pins).
	symlinkSync(join(repoRoot, "node_modules"), join(pkgDir, "node_modules"));

	const child = spawn("node", [join(pkgDir, "dist", "index.js")], {
		cwd: pkgDir,
		env: {
			...process.env,
			ANIMA_API_KEY: "ak_test_published_package",
			// Point at a closed port — the server must register tools without
			// reaching the API; no network leaves this test.
			ANIMA_API_URL: "http://127.0.0.1:9",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);

	const waitFor = (predicate: () => boolean, label: string) =>
		new Promise<void>((resolvePromise, rejectPromise) => {
			const deadline = Date.now() + 20_000;
			const timer = setInterval(() => {
				if (predicate()) {
					clearInterval(timer);
					resolvePromise();
				} else if (child.exitCode !== null) {
					clearInterval(timer);
					rejectPromise(
						new Error(
							`server exited (code ${child.exitCode}) before ${label}.\nstderr:\n${stderr}`,
						),
					);
				} else if (Date.now() > deadline) {
					clearInterval(timer);
					rejectPromise(
						new Error(`timeout waiting for ${label}.\nstderr:\n${stderr}`),
					);
				}
			}, 50);
		});

	try {
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "published-package-test", version: "0.0.1" },
			},
		});
		await waitFor(() => stdout.includes('"id":1'), "initialize response");

		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		await waitFor(() => stdout.includes('"id":2'), "tools/list response");
	} finally {
		child.kill();
	}

	const messages = stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as {
					id?: number;
					result?: {
						serverInfo?: { name: string };
						tools?: Array<{ name: string }>;
					};
				};
			} catch {
				return null;
			}
		});

	const initResponse = messages.find((m) => m?.id === 1);
	const toolsResponse = messages.find((m) => m?.id === 2);
	return {
		serverName: initResponse?.result?.serverInfo?.name ?? "",
		toolNames: (toolsResponse?.result?.tools ?? []).map((t) => t.name),
	};
}

describe("published npm package", () => {
	test(
		"the packed tarball boots under node and serves tools over stdio",
		async () => {
			const workDir = mkdtempSync(join(tmpdir(), "anima-mcp-pack-"));
			try {
				const pkgDir = packTarball(workDir);
				const { serverName, toolNames } = await driveStdioHandshake(pkgDir);

				expect(serverName).toBe("anima-mcp");
				expect(toolNames.length).toBeGreaterThan(40);
				expect(toolNames).toContain("email_send");
				expect(toolNames).toContain("vault_credential_get");
			} finally {
				rmSync(workDir, { recursive: true, force: true });
			}
		},
		{ timeout: 120_000 },
	);
});
