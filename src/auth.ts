/**
 * Browser-based authentication for the Anima MCP server.
 *
 * Uses a server-side relay (device code flow) — no localhost callback needed:
 *   1. Check --api-key flag or ANIMA_API_KEY env var
 *   2. Check cached credentials at ~/.anima/credentials.json
 *   3. If neither found, start the browser auth flow:
 *      a. POST /mcp-auth/sessions to create a pending session (returns sessionId + token + authUrl)
 *      b. Open authUrl in the browser (console.useanima.sh/install/authorize?session=ID)
 *      c. User authenticates via Clerk and clicks "Authorize"
 *      d. Console calls POST /mcp-auth/sessions/{id}/complete, which creates a scoped API key
 *      e. MCP server polls POST /mcp-auth/sessions/poll with its token
 *      f. Once completed, the API key is returned (burn-after-reading) and cached locally
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS_DIR = join(homedir(), ".anima");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");
const API_URL = process.env.ANIMA_API_URL ?? "https://api.useanima.sh";

const POLL_INTERVAL_MS = 2_000; // Poll every 2 seconds
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5-minute timeout (matches session TTL)

interface CachedCredentials {
	apiKey: string;
	apiUrl?: string;
	createdAt: string;
}

interface CreateSessionResponse {
	sessionId: string;
	token: string;
	authUrl: string;
}

interface PollSessionResponse {
	status: "PENDING" | "COMPLETED" | "DENIED" | "EXPIRED";
	apiKey?: string;
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

function saveCachedCredentials(apiKey: string, apiUrl?: string): void {
	try {
		mkdirSync(CREDENTIALS_DIR, { recursive: true });
		const data: CachedCredentials = {
			apiKey,
			apiUrl,
			createdAt: new Date().toISOString(),
		};
		writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), {
			mode: 0o600,
		});
		console.error(`Credentials saved to ${CREDENTIALS_FILE}`);
	} catch (err) {
		console.error(`Warning: Could not save credentials: ${err}`);
	}
}

/* ── Browser opener ── */

function openBrowser(url: string): void {
	const platform = process.platform;
	let command: string;
	let args: string[];

	if (platform === "darwin") {
		command = "open";
		args = [url];
	} else if (platform === "win32") {
		command = "cmd.exe";
		args = ["/c", "start", "", url];
	} else {
		command = "xdg-open";
		args = [url];
	}

	execFile(command, args, (err) => {
		if (err) {
			console.error("Could not open browser automatically.");
			console.error(`Please open this URL manually: ${url}`);
		}
	});
}

/* ── Server-side relay (device code flow) ── */

/** Create a pending auth session on the API server. */
async function createAuthSession(): Promise<CreateSessionResponse> {
	const res = await fetch(`${API_URL}/mcp-auth/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Failed to create auth session: ${res.status} ${body}`);
	}

	return res.json() as Promise<CreateSessionResponse>;
}

/** Poll the API server for session completion. */
async function pollAuthSession(token: string): Promise<string> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const res = await fetch(`${API_URL}/mcp-auth/sessions/poll`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Poll failed: ${res.status} ${body}`);
		}

		const data = (await res.json()) as PollSessionResponse;

		switch (data.status) {
			case "COMPLETED":
				if (data.apiKey) return data.apiKey;
				throw new Error("Session completed but no API key returned");

			case "DENIED":
				throw new Error("Authorization was denied by the user");

			case "EXPIRED":
				throw new Error("Authorization session expired. Please try again.");

			case "PENDING":
				// Still waiting — sleep and retry
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
				break;
		}
	}

	throw new Error("Authentication timed out after 5 minutes");
}

/** Run the full browser auth flow: create session → open browser → poll for key. */
async function browserAuthFlow(): Promise<string> {
	// 1. Create session on the API server
	const session = await createAuthSession();

	// 2. Print auth URL and open browser
	console.error("");
	console.error("┌─────────────────────────────────────────┐");
	console.error("│   Anima MCP — Browser Authentication    │");
	console.error("├─────────────────────────────────────────┤");
	console.error("│                                         │");
	console.error("│   Opening browser for sign-in...        │");
	console.error("│                                         │");
	console.error("│   If the browser doesn't open, visit:   │");
	console.error("│                                         │");
	console.error("└─────────────────────────────────────────┘");
	console.error("");
	console.error(`  ${session.authUrl}`);
	console.error("");

	openBrowser(session.authUrl);

	// 3. Poll for completion
	console.error("Waiting for authorization...");
	return pollAuthSession(session.token);
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

	// 4. Browser authentication flow (server-side relay)
	console.error("No API key found. Starting browser authentication...");
	const key = await browserAuthFlow();
	saveCachedCredentials(key, process.env.ANIMA_API_URL);
	return key;
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
