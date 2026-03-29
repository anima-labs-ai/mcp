import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../../..");

describe("Deployment readiness", () => {
	describe.skip("Dockerfile validation", () => {
		test("Dockerfile.mcp exists and is valid", () => {
			const path = resolve(ROOT, "deploy/Dockerfile.mcp");
			expect(existsSync(path)).toBe(true);

			const content = readFileSync(path, "utf-8");
			expect(content).toContain("FROM oven/bun:1");
			expect(content).toContain("EXPOSE 8014");
			expect(content).toContain("HEALTHCHECK");
			expect(content).toContain("CMD");
			expect(content).toContain("--http");
		});

		test("Dockerfile.api exists and is valid", () => {
			const path = resolve(ROOT, "deploy/Dockerfile.api");
			expect(existsSync(path)).toBe(true);

			const content = readFileSync(path, "utf-8");
			expect(content).toContain("FROM oven/bun:1");
			expect(content).toContain("EXPOSE 4001");
			expect(content).toContain("HEALTHCHECK");
			expect(content).toContain("CMD");
		});

		test("Dockerfiles use multi-stage builds", () => {
			for (const file of ["Dockerfile.mcp", "Dockerfile.api"]) {
				const content = readFileSync(resolve(ROOT, `deploy/${file}`), "utf-8");
				const fromCount = (content.match(/^FROM /gm) ?? []).length;
				expect(fromCount).toBeGreaterThanOrEqual(3);
			}
		});

		test("Dockerfiles set NODE_ENV=production", () => {
			for (const file of ["Dockerfile.mcp", "Dockerfile.api"]) {
				const content = readFileSync(resolve(ROOT, `deploy/${file}`), "utf-8");
				expect(content).toContain("NODE_ENV=production");
			}
		});
	});

	describe.skip("Caddy configuration", () => {
		test("Caddyfile.dev exists with dev routing", () => {
			const path = resolve(ROOT, "deploy/Caddyfile.dev");
			expect(existsSync(path)).toBe(true);

			const content = readFileSync(path, "utf-8");
			expect(content).toContain("auto_https off");
			expect(content).toContain("/mcp");
			expect(content).toContain("reverse_proxy mcp:8014");
			expect(content).toContain("reverse_proxy api:4001");
			expect(content).toContain("/health");
		});

		test("Caddyfile.prod exists with TLS domains", () => {
			const path = resolve(ROOT, "deploy/Caddyfile.prod");
			expect(existsSync(path)).toBe(true);

			const content = readFileSync(path, "utf-8");
			expect(content).toContain("mcp.anima.com");
			expect(content).toContain("api.anima.com");
			expect(content).toContain("reverse_proxy mcp:8014");
			expect(content).toContain("reverse_proxy api:4001");
			expect(content).not.toContain("auto_https off");
		});

		test("Production Caddyfile has SSE-compatible timeouts", () => {
			const content = readFileSync(resolve(ROOT, "deploy/Caddyfile.prod"), "utf-8");
			expect(content).toContain("read_timeout");
			expect(content).toContain("write_timeout");
		});
	});

	describe.skip("Docker Compose deploy", () => {
		test("docker-compose.deploy.yml exists", () => {
			const path = resolve(ROOT, "deploy/docker-compose.deploy.yml");
			expect(existsSync(path)).toBe(true);
		});

		test("docker-compose.deploy.yml defines api, mcp, caddy services", () => {
			const content = readFileSync(resolve(ROOT, "deploy/docker-compose.deploy.yml"), "utf-8");
			expect(content).toContain("api:");
			expect(content).toContain("mcp:");
			expect(content).toContain("caddy:");
		});

		test("MCP service depends on API", () => {
			const content = readFileSync(resolve(ROOT, "deploy/docker-compose.deploy.yml"), "utf-8");
			const mcpSection = content.split("mcp:")[1]?.split(/^\s{2}\w/m)[0] ?? "";
			expect(mcpSection).toContain("api");
		});

		test("API service connects to postgres and redis", () => {
			const content = readFileSync(resolve(ROOT, "deploy/docker-compose.deploy.yml"), "utf-8");
			expect(content).toContain("postgres");
			expect(content).toContain("redis");
		});
	});

	describe.skip("Deploy script", () => {
		test("deploy.sh exists and is executable", () => {
			const path = resolve(ROOT, "deploy/deploy.sh");
			expect(existsSync(path)).toBe(true);

			const stats = statSync(path);
			const isExecutable = (stats.mode & 0o111) !== 0;
			expect(isExecutable).toBe(true);
		});

		test("deploy.sh supports dev and prod modes", () => {
			const content = readFileSync(resolve(ROOT, "deploy/deploy.sh"), "utf-8");
			expect(content).toContain("dev)");
			expect(content).toContain("prod)");
			expect(content).toContain("Caddyfile.dev");
			expect(content).toContain("Caddyfile.prod");
		});

		test("deploy.sh checks for .env file", () => {
			const content = readFileSync(resolve(ROOT, "deploy/deploy.sh"), "utf-8");
			expect(content).toContain(".env");
		});

		test("deploy.sh waits for health checks", () => {
			const content = readFileSync(resolve(ROOT, "deploy/deploy.sh"), "utf-8");
			expect(content).toContain("healthy");
			expect(content).toContain("MAX_WAIT");
		});
	});

	describe("Health endpoint contract", () => {
		test("MCP package exports createMcpHttpServer", async () => {
			const mod = await import("../../http-transport.js");
			expect(typeof mod.createMcpHttpServer).toBe("function");
			expect(typeof mod.parseBearerToken).toBe("function");
		});
	});
});
