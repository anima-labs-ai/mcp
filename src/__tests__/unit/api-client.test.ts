import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
	ApiClient,
	ApiError,
	createApiClientFromEnv,
} from "../../api-client.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function makeMockFetch(response: Response) {
	const fn = mock(() => Promise.resolve(response));
	return fn as typeof fn & { preconnect: typeof fetch.preconnect };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function getCallArgs(mockFn: ReturnType<typeof makeMockFetch>, index = 0): [string, RequestInit] {
	const calls = mockFn.mock.calls;
	if (calls.length <= index) {
		throw new Error(`Expected at least ${index + 1} call(s), got ${calls.length}`);
	}
	return calls[index] as unknown as [string, RequestInit];
}

describe("ApiClient", () => {
	beforeEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		globalThis.fetch = ORIGINAL_FETCH;
	});

	test("constructor normalizes baseUrl trailing slash", async () => {
		const mockFetch = makeMockFetch(jsonResponse({ ok: true }));
		globalThis.fetch = mockFetch;

		const client = new ApiClient({
			baseUrl: "http://localhost:3100/",
			apiKey: "ak_test",
		});

		await client.get("/health");

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url] = getCallArgs(mockFetch);
		expect(url).toBe("http://localhost:3100/health");
	});

	test("GET builds URL and auth headers", async () => {
		const mockFetch = makeMockFetch(jsonResponse({ ok: true }));
		globalThis.fetch = mockFetch;

		const client = new ApiClient({
			baseUrl: "https://api.anima.dev",
			apiKey: "ak_123",
		});

		const data = await client.get<{ ok: boolean }>("/v1/orgs");

		expect(data).toEqual({ ok: true });
		const [url, options] = getCallArgs(mockFetch);
		expect(url).toBe("https://api.anima.dev/v1/orgs");
		expect(options.method).toBe("GET");
		expect(options.headers).toEqual({
			Authorization: "Bearer ak_123",
			Accept: "application/json",
		});
		expect(options.body).toBeUndefined();
	});

	test("POST sends JSON body and content-type", async () => {
		const mockFetch = makeMockFetch(jsonResponse({ id: "org_1" }));
		globalThis.fetch = mockFetch;

		const client = new ApiClient({
			baseUrl: "http://127.0.0.1:3100",
			apiKey: "ak_test",
		});

		await client.post("/v1/orgs", { name: "Acme" });

		const [, options] = getCallArgs(mockFetch);
		expect(options.method).toBe("POST");
		expect(options.body).toBe(JSON.stringify({ name: "Acme" }));
		expect(options.headers).toEqual({
			Authorization: "Bearer ak_test",
			Accept: "application/json",
			"Content-Type": "application/json",
		});
	});

	test("PATCH request method works", async () => {
		const mockFetch = makeMockFetch(jsonResponse({ updated: true }));
		globalThis.fetch = mockFetch;

		const client = new ApiClient({ baseUrl: "http://api", apiKey: "ak" });
		await client.patch("/v1/agents/1", { enabled: true });

		const [, options] = getCallArgs(mockFetch);
		expect(options.method).toBe("PATCH");
	});

	test("PUT request method works", async () => {
		const mockFetch = makeMockFetch(jsonResponse({ replaced: true }));
		globalThis.fetch = mockFetch;

		const client = new ApiClient({ baseUrl: "http://api", apiKey: "ak" });
		await client.put("/v1/domains/1", { verified: true });

		const [, options] = getCallArgs(mockFetch);
		expect(options.method).toBe("PUT");
	});

	test("DELETE request method works", async () => {
		const mockFetch = makeMockFetch(
			new Response(null, { status: 204, headers: { "content-length": "0" } }),
		);
		globalThis.fetch = mockFetch;

		const client = new ApiClient({ baseUrl: "http://api", apiKey: "ak" });
		const result = await client.delete("/v1/webhooks/1");

		expect(result).toBeUndefined();
		const [, options] = getCallArgs(mockFetch);
		expect(options.method).toBe("DELETE");
	});

	test("non-OK response throws ApiError with status details and body", async () => {
		const errorBody = { message: "Forbidden operation" };
		const mockFetch = makeMockFetch(
			new Response(JSON.stringify(errorBody), {
				status: 403,
				statusText: "Forbidden",
				headers: { "content-type": "application/json" },
			}),
		);
		globalThis.fetch = mockFetch;

		const client = new ApiClient({ baseUrl: "http://api", apiKey: "ak" });

		await expect(client.get("/v1/protected")).rejects.toBeInstanceOf(ApiError);

		globalThis.fetch = makeMockFetch(
			new Response(JSON.stringify(errorBody), {
				status: 403,
				statusText: "Forbidden",
				headers: { "content-type": "application/json" },
			}),
		);

		await client.get("/v1/protected").catch((error: unknown) => {
			expect(error).toBeInstanceOf(ApiError);
			if (error instanceof ApiError) {
				expect(error.status).toBe(403);
				expect(error.statusText).toBe("Forbidden");
				expect(error.body).toEqual(errorBody);
				expect(error.message).toBe("Forbidden operation");
			}
		});
	});

	test("timeout configures AbortController", async () => {
		const abortError = new Error("The operation was aborted.");
		abortError.name = "AbortError";

		const mockFetch = mock((_url: string, options?: RequestInit) => {
			expect(options?.signal).toBeDefined();
			return Promise.reject(abortError);
		});
		(mockFetch as unknown as Record<string, unknown>).preconnect = undefined;
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const client = new ApiClient({
			baseUrl: "http://api",
			apiKey: "ak",
			timeoutMs: 25,
		});

		await expect(client.get("/v1/slow")).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	test("hasMasterKey returns true only when configured", () => {
		const withMaster = new ApiClient({
			baseUrl: "http://api",
			apiKey: "ak",
			masterKey: "mk",
		});
		const withoutMaster = new ApiClient({ baseUrl: "http://api", apiKey: "ak" });

		expect(withMaster.hasMasterKey()).toBe(true);
		expect(withoutMaster.hasMasterKey()).toBe(false);
	});

	test("createApiClientFromEnv reads env vars", async () => {
		process.env.ANIMA_API_URL = "http://env-api:9999";
		process.env.ANIMA_API_KEY = "ak_env";
		process.env.ANIMA_MASTER_KEY = "mk_env";

		const mockFetch = makeMockFetch(jsonResponse({ ok: true }));
		globalThis.fetch = mockFetch;

		const client = createApiClientFromEnv();
		expect(client.hasMasterKey()).toBe(true);

		await client.get("/env-check");
		const [url, options] = getCallArgs(mockFetch);
		expect(url).toBe("http://env-api:9999/env-check");
		expect(options.headers).toEqual({
			Authorization: "Bearer ak_env",
			Accept: "application/json",
		});
	});

	test("auth header uses API key by default and master key when requested", async () => {
		const mockFetch = makeMockFetch(jsonResponse({ ok: true }));
		globalThis.fetch = mockFetch;

		const client = new ApiClient({
			baseUrl: "http://api",
			apiKey: "ak_default",
			masterKey: "mk_admin",
		});

		await client.get("/v1/default-auth");

		const mockFetch2 = makeMockFetch(jsonResponse({ ok: true }));
		globalThis.fetch = mockFetch2;
		await client.get("/v1/master-auth", { useMasterKey: true });

		const [, firstOptions] = getCallArgs(mockFetch);
		const [, secondOptions] = getCallArgs(mockFetch2);

		expect((firstOptions.headers as Record<string, string>).Authorization).toBe(
			"Bearer ak_default",
		);
		expect((secondOptions.headers as Record<string, string>).Authorization).toBe(
			"Bearer mk_admin",
		);
	});
});
