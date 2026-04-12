import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
	type CircuitBreaker,
	type CircuitBreakerOptions,
	CircuitOpenError,
	createCircuitBreaker,
} from "./circuit-breaker.js";
import { createMcpMetrics, type McpMetrics } from "./metrics.js";
import {
	createMcpRateLimiter,
	type McpRateLimiter,
	type McpRateLimiterOptions,
} from "./rate-limiter.js";
import {
	createSessionRegistry,
	type SessionRegistry,
	type SessionRegistryOptions,
} from "./session-registry.js";

export const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"Content-Type, Authorization, mcp-session-id, Last-Event-ID, mcp-protocol-version",
	"Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

export function jsonError(
	res: ServerResponse,
	status: number,
	message: string,
) {
	res.writeHead(status, {
		...CORS_HEADERS,
		"Content-Type": "application/json",
	});
	res.end(JSON.stringify({ error: message }));
}

export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

export function parseBearerToken(req: IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	if (!header) return undefined;
	const match = header.match(/^Bearer\s+(\S+)$/i);
	return match?.[1];
}

interface McpSession {
	server: McpServer;
	transport: StreamableHTTPServerTransport;
	apiKeyId?: string;
	orgId?: string;
}

export interface McpAuthContext {
	apiKeyId: string;
	orgId: string;
}

export interface McpAuthError {
	status: number;
	message: string;
}

export interface OAuthDiscovery {
	/** Canonical URL of the MCP server, e.g. "https://mcp.useanima.sh" */
	mcpBaseUrl: string;
	/** URL of the OAuth authorization server, e.g. "https://console.useanima.sh" */
	authServerUrl: string;
}

export interface HttpTransportOptions {
	port?: number;
	onShutdown?: () => void;
	authenticate?: (req: IncomingMessage) => Promise<McpAuthContext | undefined>;
	oauth?: OAuthDiscovery;
	sessionRegistry?: SessionRegistryOptions;
	rateLimiter?: McpRateLimiterOptions;
	circuitBreaker?: CircuitBreakerOptions;
}

export interface HttpTransportServer {
	httpServer: Server;
	sessions: Map<string, McpSession>;
	registry: SessionRegistry;
	rateLimiter: McpRateLimiter;
	circuitBreaker: CircuitBreaker;
	metrics: McpMetrics;
	close: () => Promise<void>;
}

export function createMcpHttpServer(
	serverFactory: (() => McpServer) | McpServer,
	options?: HttpTransportOptions,
): HttpTransportServer {
	const sessions = new Map<string, McpSession>();
	const port = options?.port ?? 0;
	const createServer_ =
		typeof serverFactory === "function" ? serverFactory : () => serverFactory;
	const startedAt = Date.now();

	const registry = createSessionRegistry(options?.sessionRegistry);
	const rateLimiter = createMcpRateLimiter(options?.rateLimiter);
	const circuitBreaker = createCircuitBreaker(options?.circuitBreaker);
	const metrics = createMcpMetrics();

	registry.startSweep(async (sessionId: string) => {
		const session = sessions.get(sessionId);
		if (session) {
			await session.transport.close();
			await session.server.close();
			sessions.delete(sessionId);
			metrics.sessionClosed();
		}
	});

	function setRateLimitHeaders(
		res: ServerResponse,
		remaining: number,
		limit: number,
		retryAfterMs?: number,
	): void {
		res.setHeader("X-RateLimit-Limit", limit);
		res.setHeader("X-RateLimit-Remaining", remaining);
		if (retryAfterMs !== undefined) {
			res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
		}
	}

	const httpServer = createServer(
		async (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", `http://localhost:${port}`);

			if (req.method === "OPTIONS") {
				res.writeHead(204, CORS_HEADERS);
				res.end();
				return;
			}

			// OAuth protected resource metadata (RFC 9728)
			if (
				options?.oauth &&
				url.pathname === "/.well-known/oauth-protected-resource"
			) {
				res.writeHead(200, {
					...CORS_HEADERS,
					"Content-Type": "application/json",
					"Cache-Control": "public, max-age=3600",
				});
				res.end(
					JSON.stringify({
						resource: options.oauth.mcpBaseUrl,
						authorization_servers: [options.oauth.authServerUrl],
						bearer_methods_supported: ["header"],
					}),
				);
				return;
			}

			if (url.pathname === "/health") {
				const uptimeMs = Date.now() - startedAt;
				const metricsSnapshot = metrics.snapshot();
				const registryStats = registry.stats();
				res.writeHead(200, {
					...CORS_HEADERS,
					"Content-Type": "application/json",
				});
				res.end(
					JSON.stringify({
						status: "ok",
						sessions: sessions.size,
						uptimeSeconds: Math.floor(uptimeMs / 1000),
						startedAt: new Date(startedAt).toISOString(),
						metrics: metricsSnapshot,
						registry: registryStats,
					}),
				);
				return;
			}

			if (url.pathname !== "/mcp") {
				jsonError(res, 404, "Not Found");
				return;
			}

			if (req.method === "DELETE") {
				const sessionId = req.headers["mcp-session-id"] as string | undefined;
				const session = sessionId ? sessions.get(sessionId) : undefined;
				if (session) {
					if (sessionId) {
						sessions.delete(sessionId);
						registry.remove(sessionId);
						metrics.sessionClosed();
					}
					await session.transport.close();
					await session.server.close();
					res.writeHead(200, CORS_HEADERS);
					res.end();
				} else {
					jsonError(res, 404, "Session not found");
				}
				return;
			}

			if (req.method === "GET") {
				const sessionId = req.headers["mcp-session-id"] as string | undefined;
				const session = sessionId ? sessions.get(sessionId) : undefined;
				if (session) {
					if (sessionId) registry.touch(sessionId);
					await session.transport.handleRequest(req, res);
				} else {
					jsonError(res, 400, "Missing or invalid mcp-session-id header");
				}
				return;
			}

			if (req.method === "POST") {
				const sessionId = req.headers["mcp-session-id"] as string | undefined;

				let body: unknown;
				try {
					const raw = await readBody(req);
					body = JSON.parse(raw);
				} catch {
					jsonError(res, 400, "Invalid JSON body");
					return;
				}

				if (sessionId) {
					const session = sessions.get(sessionId);
					if (session) {
						registry.touch(sessionId);

						const apiKeyId = session.apiKeyId ?? "unknown";
						const orgId = session.orgId ?? "unknown";

						const requestCheck = rateLimiter.checkRequest(apiKeyId);
						if (!requestCheck.allowed) {
							metrics.rateLimitHit();
							setRateLimitHeaders(
								res,
								requestCheck.remaining,
								requestCheck.limit,
								requestCheck.retryAfterMs,
							);
							jsonError(res, 429, "Rate limit exceeded");
							return;
						}

						try {
							await circuitBreaker.execute(orgId, async () => {
								const callStart = Date.now();
								await session.transport.handleRequest(req, res, body);
								metrics.toolCallRecorded(Date.now() - callStart);
							});
						} catch (err) {
							if (err instanceof CircuitOpenError) {
								metrics.circuitBreakerTripped(orgId);
								setRateLimitHeaders(res, 0, 0, err.retryAfterMs);
								jsonError(res, 503, err.message);
							}
						}
						return;
					}
					jsonError(
						res,
						404,
						"Session not found. Create a new session with an initialize request.",
					);
					return;
				}

				if (!isInitializeRequest(body)) {
					jsonError(
						res,
						400,
						"First request must be an MCP initialize request",
					);
					return;
				}

				let authContext: McpAuthContext | undefined;
				if (options?.authenticate) {
					try {
						authContext = await options.authenticate(req);
					} catch (err) {
						const authErr = err as McpAuthError;
						metrics.authFailure();
						const status = authErr.status || 401;
						const headers: Record<string, string> = {
							...CORS_HEADERS,
							"Content-Type": "application/json",
						};
						if (status === 401 && options.oauth) {
							headers["WWW-Authenticate"] =
								`Bearer resource_metadata="${options.oauth.mcpBaseUrl}/.well-known/oauth-protected-resource"`;
						}
						res.writeHead(status, headers);
						res.end(
							JSON.stringify({
								error: authErr.message || "Authentication failed",
							}),
						);
						return;
					}
				}

				const apiKeyId = authContext?.apiKeyId ?? "anonymous";
				const orgId = authContext?.orgId ?? "anonymous";

				const sessionCheck = rateLimiter.checkSessionCreation(
					apiKeyId,
					registry.countByKey(apiKeyId),
				);
				if (!sessionCheck.allowed) {
					metrics.rateLimitHit();
					setRateLimitHeaders(
						res,
						sessionCheck.remaining,
						sessionCheck.limit,
						sessionCheck.retryAfterMs,
					);
					jsonError(res, 429, "Too many active sessions for this API key");
					return;
				}

				if (!registry.canCreateSession(apiKeyId)) {
					jsonError(
						res,
						429,
						"Maximum concurrent sessions reached for this API key",
					);
					return;
				}

				const mcpServer = createServer_();
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (sid: string) => {
						sessions.set(sid, {
							server: mcpServer,
							transport,
							apiKeyId,
							orgId,
						});
						registry.register(sid, apiKeyId, orgId);
						metrics.sessionCreated();
					},
				});

				transport.onclose = () => {
					const sid = transport.sessionId;
					if (sid && sessions.has(sid)) {
						sessions.delete(sid);
						registry.remove(sid);
						metrics.sessionClosed();
					}
				};

				await mcpServer.connect(transport);
				await transport.handleRequest(req, res, body);
				return;
			}

			jsonError(res, 405, "Method not allowed");
		},
	);

	const close = async () => {
		registry.stopSweep();
		for (const session of sessions.values()) {
			await session.transport.close();
			await session.server.close();
		}
		sessions.clear();
		httpServer.close();
		options?.onShutdown?.();
	};

	return {
		httpServer,
		sessions,
		registry,
		rateLimiter,
		circuitBreaker,
		metrics,
		close,
	};
}
