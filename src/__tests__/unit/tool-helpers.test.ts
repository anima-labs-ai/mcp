import { describe, expect, test } from "bun:test";

import { ApiError } from "../../api-client.js";
import {
	requireMasterKeyGuard,
	requiresMasterKey,
	toolError,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";

describe("tool helpers", () => {
	test("toolSuccess returns MCP text content for string", () => {
		expect(toolSuccess("done")).toEqual({
			content: [{ type: "text", text: "done" }],
		});
	});

	test("toolSuccess serializes object as pretty JSON", () => {
		const result = toolSuccess({ id: "org_1", active: true });

		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("\"id\": \"org_1\"");
		expect(result.content[0]?.text).toContain("\"active\": true");
	});

	test("toolSuccess serializes arrays", () => {
		const result = toolSuccess([1, 2, 3]);
		expect(result).toEqual({
			content: [{ type: "text", text: "[\n  1,\n  2,\n  3\n]" }],
		});
	});

	test("toolError returns MCP error shape", () => {
		expect(toolError("failed")).toEqual({
			content: [{ type: "text", text: "Error: failed" }],
			isError: true,
		});
	});

	test("requiresMasterKey returns true for protected tools", () => {
		expect(requiresMasterKey("org_delete")).toBe(true);
		expect(requiresMasterKey("security_update_policy")).toBe(true);
	});

	test("requiresMasterKey returns false for regular tools", () => {
		expect(requiresMasterKey("email_send")).toBe(false);
		expect(requiresMasterKey("domain_list")).toBe(false);
	});

	test("requireMasterKeyGuard throws when master key unavailable", () => {
		expect(() =>
			requireMasterKeyGuard({
				client: {} as never,
				hasMasterKey: false,
			}),
		).toThrow("ANIMA_MASTER_KEY");
	});

	test("requireMasterKeyGuard does not throw when master key available", () => {
		expect(() =>
			requireMasterKeyGuard({
				client: {} as never,
				hasMasterKey: true,
			}),
		).not.toThrow();
	});

	test("withErrorHandling wraps handler and passes args", async () => {
		const wrapped = withErrorHandling(
			async (args: { input: string }) => toolSuccess(`echo:${args.input}`),
			{ client: {} as never, hasMasterKey: false },
		);

		const result = await wrapped({ input: "hello" });
		expect(result).toEqual({
			content: [{ type: "text", text: "echo:hello" }],
		});
	});

	test("withErrorHandling catches generic errors", async () => {
		const wrapped = withErrorHandling(
			async () => {
				throw new Error("boom");
			},
			{ client: {} as never, hasMasterKey: false },
		);

		const result = await wrapped({});
		expect(result).toEqual({
			content: [{ type: "text", text: "Error: boom" }],
			isError: true,
		});
	});

	test("withErrorHandling catches ApiError and returns its message", async () => {
		const wrapped = withErrorHandling(
			async () => {
				throw new ApiError(401, "Unauthorized", { message: "Invalid API key" });
			},
			{ client: {} as never, hasMasterKey: false },
		);

		const result = await wrapped({});
		expect(result).toEqual({
			content: [{ type: "text", text: "Error: Invalid API key" }],
			isError: true,
		});
	});
});
