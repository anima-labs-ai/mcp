import type { ToolRegistrationOptions } from "../tool-helpers.js";
import { toolSuccess } from "../tool-helpers.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function toEmailList(payload: unknown): UnknownRecord[] {
	if (Array.isArray(payload)) {
		return payload
			.map((item) => asRecord(item))
			.filter((item): item is UnknownRecord => Boolean(item));
	}

	const record = asRecord(payload);
	if (!record) return [];

	const candidates = [record.items, record.messages, record.data];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			return candidate
				.map((item) => asRecord(item))
				.filter((item): item is UnknownRecord => Boolean(item));
		}
	}

	return [];
}

function formatEmails(payload: unknown): string {
	const emails = toEmailList(payload);
	if (emails.length === 0) {
		return "No recent emails found.";
	}

	return emails
		.map((email, index) => {
			const from =
				typeof email.fromAddress === "string"
					? email.fromAddress
					: typeof email.from === "string"
						? email.from
						: "unknown sender";
			const subject =
				typeof email.subject === "string" && email.subject.length > 0
					? email.subject
					: "(no subject)";
			const when =
				typeof email.createdAt === "string"
					? email.createdAt
					: typeof email.date === "string"
						? email.date
						: "unknown date";

			return `${index + 1}. ${from} | ${subject} | ${when}`;
		})
		.join("\n");
}

function toText(data: unknown): string {
	return toolSuccess(data).content[0]?.text ?? "";
}

function formatAgentIdentity(payload: unknown): string {
	const account = asRecord(payload);
	if (!account) {
		return "Unable to read agent identity details.";
	}

	const org = asRecord(account.org);
	const agent = asRecord(account.agent);
	const roles = asArray(account.roles).filter(
		(item): item is string => typeof item === "string",
	);

	const lines = [
		`Org ID: ${typeof account.orgId === "string" ? account.orgId : typeof org?.id === "string" ? org.id : "unknown"}`,
		`Org Name: ${typeof org?.name === "string" ? org.name : "unknown"}`,
		`Agent ID: ${typeof account.agentId === "string" ? account.agentId : typeof agent?.id === "string" ? agent.id : "n/a"}`,
		`Agent Name: ${typeof agent?.name === "string" ? agent.name : "n/a"}`,
		`Auth Type: ${typeof account.keyType === "string" ? account.keyType : "unknown"}`,
	];

	if (roles.length > 0) {
		lines.push(`Roles: ${roles.join(", ")}`);
	}

	return lines.join("\n");
}

export function registerResources(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.resource(
		"Agent Inbox",
		"anima://inbox",
		{
			description: "Recent emails in inbox",
		},
		async (uri) => {
			const emails = await options.context.client.get("/email?limit=20");
			const text = toText(formatEmails(emails));

			return {
				contents: [
					{
						uri: uri.href,
						text,
						mimeType: "text/plain",
					},
				],
			};
		},
	);

	server.resource(
		"Agent Identity",
		"anima://agent-info",
		{
			description: "Current authenticated identity and agent details",
		},
		async (uri) => {
			const org = await options.context.client.get("/orgs/me");
			const agents = await options.context.client.get<{ items: unknown[] }>("/agents");
			const identity = { org, agents: agents.items };
			const text = toText(formatAgentIdentity(identity));

			return {
				contents: [
					{
						uri: uri.href,
						text,
						mimeType: "text/plain",
					},
				],
			};
		},
	);
}
