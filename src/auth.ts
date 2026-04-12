/**
 * Browser-based authentication for the Anima MCP server.
 *
 * Flow:
 *   1. Check --api-key flag or ANIMA_API_KEY env var
 *   2. Check cached credentials at ~/.anima/credentials.json
 *   3. If neither found, open browser for OAuth-style login:
 *      a. Start temporary localhost HTTP server on a random port
 *      b. Open console.useanima.sh/install/authorize?callback_port=PORT
 *      c. User authenticates via Clerk, console creates a scoped API key
 *      d. Console redirects to http://localhost:PORT/callback?key=sk_live_xxx
 *      e. MCP server receives key, caches it, closes local server
 */

import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS_DIR = join(homedir(), ".anima");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");
const CONSOLE_URL =
	process.env.ANIMA_CONSOLE_URL ?? "https://console.useanima.sh";

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

/* ���─ Localhost callback server ── */

function startCallbackServer(): Promise<{ key: string; port: number }> {
	return new Promise((resolve, reject) => {
		let server: Server;
		const timeout = setTimeout(() => {
			server?.close();
			reject(new Error("Authentication timed out after 5 minutes"));
		}, 5 * 60 * 1000);

		/** CORS + Private Network Access headers.
		 *  Chrome's PNA policy blocks fetch/Image from public HTTPS pages to localhost
		 *  unless the server handles the preflight with Access-Control-Allow-Private-Network. */
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Private-Network": "true",
		};

		server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");

			// Handle CORS preflight (required for Chrome Private Network Access)
			if (req.method === "OPTIONS") {
				res.writeHead(204, corsHeaders);
				res.end();
				return;
			}

			if (url.pathname === "/callback") {
				const key = url.searchParams.get("key");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(200, { "Content-Type": "text/html", ...corsHeaders });
					res.end(errorPage(error));
					clearTimeout(timeout);
					server.close();
					reject(new Error(`Authentication failed: ${error}`));
					return;
				}

				if (key) {
					res.writeHead(200, { "Content-Type": "text/html", ...corsHeaders });
					res.end(successPage());
					clearTimeout(timeout);
					server.close();
					const addr = server.address();
					const port =
						typeof addr === "object" && addr ? addr.port : 0;
					resolve({ key, port });
					return;
				}
			}

			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
		});

		// Listen on random available port
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			const authUrl = `${CONSOLE_URL}/install/authorize?callback_port=${port}`;
			console.error("");
			console.error("┌─────────────────────────────────────────┐");
			console.error("│   Anima MCP — Browser Authentication    │");
			console.error("├─────────────────────��───────────────────┤");
			console.error("│                                         │");
			console.error("│   Opening browser for sign-in...        │");
			console.error("│                                         │");
			console.error("│   If the browser doesn't open, visit:   │");
			console.error("│                                         │");
			console.error("└─────────────────────────────���───────────┘");
			console.error("");
			console.error(`  ${authUrl}`);
			console.error("");
			openBrowser(authUrl);
		});

		server.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

/* ── HTML pages ── */

function successPage(): string {
	return `<!DOCTYPE html>
<html>
<head>
  <title>Anima MCP — Authenticated</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa; }
    .card { text-align: center; padding: 3rem; max-width: 400px; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
    p { color: #888; font-size: 0.875rem; margin: 0; }
    .brand { color: #22c55e; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#x2713;</div>
    <h1><span class="brand">Anima</span> MCP Authenticated</h1>
    <p>You can close this tab and return to your AI tool.</p>
  </div>
</body>
</html>`;
}

function errorPage(error: string): string {
	const safeError = error.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
	return `<!DOCTYPE html>
<html>
<head>
  <title>Anima MCP — Error</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa; }
    .card { text-align: center; padding: 3rem; max-width: 400px; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
    p { color: #ef4444; font-size: 0.875rem; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#x2717;</div>
    <h1>Authentication Failed</h1>
    <p>${safeError}</p>
  </div>
</body>
</html>`;
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

	// 4. Browser authentication flow
	console.error("No API key found. Starting browser authentication...");
	const { key } = await startCallbackServer();
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
