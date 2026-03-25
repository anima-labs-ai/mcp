import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
} from "../../tool-helpers.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

function toPhoneStatusList(payload: unknown): Array<{
	phoneNumber: string;
	status: string;
	capabilities: string[];
}> {
	const root = asRecord(payload);
	const candidates = [
		payload,
		root?.items,
		root?.numbers,
		root?.data,
	];

	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue;

		return candidate
			.map((entry) => asRecord(entry))
			.filter((entry): entry is UnknownRecord => Boolean(entry))
			.map((entry) => {
				const phoneNumber =
					typeof entry.phoneNumber === "string"
						? entry.phoneNumber
						: typeof entry.number === "string"
							? entry.number
							: "unknown";
				const status =
					typeof entry.status === "string" ? entry.status : "unknown";
				const capabilities = Array.isArray(entry.capabilities)
					? entry.capabilities.filter(
							(value): value is string => typeof value === "string",
						)
					: [];

				return { phoneNumber, status, capabilities };
			});
	}

	return [];
}

const phoneSearchSchema = z.object({
	country: z
		.string()
		.optional()
		.describe("Optional ISO country code to scope number search."),
	areaCode: z
		.string()
		.optional()
		.describe("Optional local area code filter for matching numbers."),
	contains: z
		.string()
		.optional()
		.describe("Optional digit sequence that returned numbers should contain."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional maximum number of available results to return."),
});

const phoneProvisionSchema = z.object({
	phoneNumber: z
		.string()
		.describe("Phone number to provision, typically in E.164 format."),
	capabilities: z
		.array(z.string())
		.optional()
		.describe("Optional capability list such as sms or voice for the number."),
});

const phoneReleaseSchema = z.object({
	phoneNumber: z
		.string()
		.describe("Provisioned phone number to release."),
});

const phoneSendSmsSchema = z.object({
	to: z
		.string()
		.describe("Destination phone number for the SMS message."),
	body: z
		.string()
		.describe("Text message body to send."),
	from: z
		.string()
		.optional()
		.describe("Optional sender phone number if a specific origin is required."),
});

const emptySchema = z.object({});

export function registerPhoneTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"phone_search",
		"Search available phone numbers for provisioning by geography or digit pattern. Use this to find suitable numbers before provisioning.",
		phoneSearchSchema.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.country) params.set("country", args.country);
			if (args.areaCode) params.set("areaCode", args.areaCode);
			if (args.contains) params.set("contains", args.contains);
			if (args.limit !== undefined) params.set("limit", String(args.limit));

			const path = params.toString() ? `/phone/search?${params}` : "/phone/search";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"phone_provision",
		"Provision a selected phone number for the agent and assign optional capabilities. Use this after choosing a number from phone_search.",
		phoneProvisionSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/phone/provision", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"phone_release",
		"Release a previously provisioned phone number so it is no longer assigned. Use this when cleaning up unused or temporary numbers.",
		phoneReleaseSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/phone/release", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"phone_list",
		"List all currently provisioned phone numbers in the workspace. Use this to review active inventory and assigned capabilities.",
		emptySchema.shape,
		withErrorHandling(async (_args, context) => {
			const result = await context.client.get<unknown>("/phone/numbers");
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"phone_send_sms",
		"Send an SMS message to a destination phone number from an assigned sender number. Use this for outbound notifications or conversational messaging.",
		phoneSendSmsSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/phone/send-sms", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"phone_status",
		"Get a status-oriented view of provisioned numbers including capability flags. Use this to verify readiness and operational state for messaging workflows.",
		emptySchema.shape,
		withErrorHandling(async (_args, context) => {
			const result = await context.client.get<unknown>("/phone/numbers");
			const items = toPhoneStatusList(result);
			return toolSuccess({
				count: items.length,
				items,
			});
		}, options.context),
	);
}
