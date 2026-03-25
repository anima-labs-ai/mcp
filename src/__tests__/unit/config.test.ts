import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	DEFAULTS,
	MASTER_KEY_TOOLS,
	SERVER_INFO,
	loadConfig,
} from "../../config.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_ARGV = [...process.argv];

describe("loadConfig", () => {
	beforeEach(() => {
		process.env = { ...ORIGINAL_ENV };
		process.argv = [...ORIGINAL_ARGV];
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		process.argv = [...ORIGINAL_ARGV];
	});

	test("uses defaults when env vars and args are absent", () => {
		process.env.ANIMA_API_URL = undefined;
		process.env.ANIMA_API_KEY = undefined;
		process.env.ANIMA_MASTER_KEY = undefined;
		process.env.MCP_PORT = undefined;

		const config = loadConfig(["bun", "index.ts"]);

		expect(config.apiUrl).toBe(DEFAULTS.apiUrl);
		expect(config.apiKey).toBe("");
		expect(config.masterKey).toBeUndefined();
		expect(config.httpMode).toBe(false);
		expect(config.httpPort).toBe(8014);
	});

	test("reads ANIMA_API_URL from env", () => {
		process.env.ANIMA_API_URL = "https://custom.api";

		const config = loadConfig(["bun", "index.ts"]);

		expect(config.apiUrl).toBe("https://custom.api");
	});

	test("reads ANIMA_API_KEY and ANIMA_MASTER_KEY from env", () => {
		process.env.ANIMA_API_KEY = "ak_env";
		process.env.ANIMA_MASTER_KEY = "mk_env";

		const config = loadConfig(["bun", "index.ts"]);

		expect(config.apiKey).toBe("ak_env");
		expect(config.masterKey).toBe("mk_env");
	});

	test("--http flag enables httpMode", () => {
		process.argv = ["bun", "index.ts", "--http"];

		const config = loadConfig();

		expect(config.httpMode).toBe(true);
	});

	test("--port=9000 sets httpPort to 9000", () => {
		process.argv = ["bun", "index.ts", "--port=9000"];

		const config = loadConfig();

		expect(config.httpPort).toBe(9000);
	});

	test("MCP_PORT env is used when --port is not provided", () => {
		process.env.MCP_PORT = "8123";

		const config = loadConfig(["bun", "index.ts"]);

		expect(config.httpPort).toBe(8123);
	});

	test("MASTER_KEY_TOOLS contains expected sensitive tool names", () => {
		expect(MASTER_KEY_TOOLS.has("org_create")).toBe(true);
		expect(MASTER_KEY_TOOLS.has("org_delete")).toBe(true);
		expect(MASTER_KEY_TOOLS.has("agent_rotate_key")).toBe(true);
		expect(MASTER_KEY_TOOLS.has("security_update_policy")).toBe(true);
		expect(MASTER_KEY_TOOLS.has("email_send")).toBe(false);
	});

	test("SERVER_INFO has stable metadata", () => {
		expect(SERVER_INFO.name).toBe("anima-mcp");
		expect(SERVER_INFO.version).toBe("2.0.0");
		expect(SERVER_INFO.description).toContain("Anima MCP Server");
	});

	test("DEFAULTS exports expected constant values", () => {
		expect(DEFAULTS.apiUrl).toBe("http://127.0.0.1:3100");
		expect(DEFAULTS.mcpPort).toBe(8014);
		expect(DEFAULTS.requestTimeoutMs).toBe(30_000);
		expect(DEFAULTS.maxListLimit).toBe(100);
		expect(DEFAULTS.defaultListLimit).toBe(20);
	});
});
