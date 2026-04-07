// Core infrastructure
export {
	ApiClient,
	ApiError,
	createApiClientFromEnv,
	type ApiClientConfig,
	type ApiResponse,
} from "./api-client.js";

export {
	MASTER_KEY_TOOLS,
	SERVER_INFO,
	DEFAULTS,
	loadConfig,
	type McpConfig,
} from "./config.js";

// Tool helpers
export {
	requiresMasterKey,
	toolSuccess,
	toolError,
	withErrorHandling,
	requireMasterKeyGuard,
	type ToolContext,
	type ToolRegistrationOptions,
	type DomainRegistrar,
} from "./tool-helpers.js";

// HTTP transport
export {
	createMcpHttpServer,
	CORS_HEADERS,
	jsonError,
	readBody,
	parseBearerToken,
	type HttpTransportOptions,
	type HttpTransportServer,
	type McpAuthContext,
	type McpAuthError,
} from "./http-transport.js";

// Rate limiter
export {
	createMcpRateLimiter,
	type McpRateLimiter,
	type McpRateLimiterOptions,
	type RateLimitResult,
} from "./rate-limiter.js";

// Circuit breaker
export {
	createCircuitBreaker,
	CircuitOpenError,
	type CircuitBreaker,
	type CircuitBreakerOptions,
	type CircuitState,
} from "./circuit-breaker.js";

// Session registry
export {
	createSessionRegistry,
	type SessionRegistry,
	type SessionRegistryOptions,
	type SessionMetadata,
	type RegistryStats,
} from "./session-registry.js";

// Metrics
export {
	createMcpMetrics,
	type McpMetrics,
	type MetricsSnapshot,
} from "./metrics.js";
