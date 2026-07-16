/**
 * API-key resolution for the Anima MCP server.
 *
 * Order: --api-key flag → ANIMA_API_KEY env var → cached credentials at
 * ~/.anima/credentials.json. If none is found we fail with instructions —
 * the old "browser auth" fallback used the session-based /mcp-auth relay,
 * which the API removed in favor of OAuth PKCE (it had been failing with a
 * deprecation error, so the browser dance could never produce a key).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS_DIR = join(homedir(), ".anima");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");

interface CachedCredentials {
	apiKey: string;
	apiUrl?: string;
	createdAt: string;
}

/* ── CLI flag parsing ── */

/** Extract --api-key=VALUE from process.argv */
export function parseApiKeyFlag(args: string[] = process.argv): string | null {
	for (const arg of args) {
		if (arg.startsWith("--api-key=")) {
			return arg.slice("--api-key=".length);
		}
	}
	// Also check --api-key VALUE (space-separated)
	const idx = args.indexOf("--api-key");
	if (idx !== -1 && idx + 1 < args.length) {
		return args[idx + 1];
	}
	return null;
}

/* ── Credential caching ── */

function readCachedCredentials(): CachedCredentials | null {
	try {
		const raw = readFileSync(CREDENTIALS_FILE, "utf-8");
		const parsed = JSON.parse(raw) as CachedCredentials;
		if (parsed.apiKey) return parsed;
		return null;
	} catch {
		return null;
	}
}

/* ── Main resolver ── */

/**
 * Resolve an API key from CLI flags, environment, cache, or browser auth.
 * Returns the API key string ready for use.
 */
export async function resolveApiKey(
	args: string[] = process.argv,
): Promise<string> {
	// 1. CLI flag: --api-key=VALUE
	const flagKey = parseApiKeyFlag(args);
	if (flagKey) {
		console.error("Using API key from --api-key flag");
		return flagKey;
	}

	// 2. Environment variable
	const envKey = process.env.ANIMA_API_KEY;
	if (envKey) {
		console.error("Using API key from ANIMA_API_KEY env var");
		return envKey;
	}

	// 3. Cached credentials
	const cached = readCachedCredentials();
	if (cached) {
		console.error("Using cached credentials from ~/.anima/credentials.json");
		return cached.apiKey;
	}

	// 4. Fail with instructions. (The old fallback here launched a browser
	// "session" auth flow against POST /mcp-auth/sessions — an API surface
	// that was removed in favor of OAuth PKCE, so it could never complete.)
	throw new Error(
		[
			"No Anima API key found.",
			"Set ANIMA_API_KEY=ak_... (create a key at https://console.useanima.sh),",
			"pass --api-key=ak_..., or run `anima setup-mcp` to configure your client.",
		].join(" "),
	);
}

/**
 * Clear cached credentials (for logout).
 */
export function clearCachedCredentials(): boolean {
	try {
		writeFileSync(CREDENTIALS_FILE, "{}", { mode: 0o600 });
		console.error("Credentials cleared.");
		return true;
	} catch {
		return false;
	}
}
