import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	sendOutput,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

function extractEmailAddress(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const address = extractEmailAddress(item);
			if (address) return address;
		}
		return undefined;
	}

	const record = asRecord(value);
	if (!record) return undefined;

	const email = record.email;
	if (typeof email === "string") return email;

	const address = record.address;
	if (typeof address === "string") return address;

	return undefined;
}

function extractStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	if (typeof value === "string") {
		return [value];
	}
	return [];
}

function dedupeStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function ensureReplySubject(subject: string): string {
	return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function ensureForwardSubject(subject: string): string {
	return /^fwd:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

function extractHeaderId(original: UnknownRecord): string | undefined {
	const messageId = original.messageId;
	if (typeof messageId === "string") return messageId;

	const id = original.id;
	if (typeof id === "string") return id;

	return undefined;
}

function extractReferences(original: UnknownRecord): string[] {
	const refs = extractStringArray(original.references);
	const inReplyTo = original.inReplyTo;
	if (typeof inReplyTo === "string") refs.push(inReplyTo);

	const headerId = extractHeaderId(original);
	if (headerId) refs.push(headerId);

	return dedupeStrings(refs);
}

function stringifyValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

// Attachment shape mirrors the API's EmailAttachmentInput contract.
// Provide exactly one of `content` (base64-inline) or `url` (public URL
// for server-fetch). Optional `contentId` for inline HTML images.
const emailAttachmentSchema = z
	.object({
		filename: z.string().optional().describe("Filename presented to the recipient."),
		contentId: z
			.string()
			.optional()
			.describe("Content-ID for inline images referenced via `cid:<id>` in HTML body."),
		contentType: z
			.string()
			.optional()
			.describe("MIME type. Auto-detected from filename if omitted."),
		content: z.string().optional().describe("Base64-encoded attachment bytes."),
		url: z.string().optional().describe("Public URL the server fetches and attaches."),
	})
	.describe(
		"File attachment for outbound email. Provide exactly one of `content` (base64-inline) or `url` (server-fetch).",
	);

const emailSendSchema = z.object({
	agentId: z.string().describe("Agent ID sending the email."),
	to: z.array(z.string()).describe("List of recipient email addresses."),
	subject: z.string().describe("Subject line for the outgoing email."),
	body: z.string().describe("Plain-text body content for the email."),
	bodyHtml: z
		.string()
		.optional()
		.describe("Optional HTML body content for rich email formatting."),
	cc: z.array(z.string()).optional().describe("Optional CC recipient email addresses."),
	bcc: z.array(z.string()).optional().describe("Optional BCC recipient email addresses."),
	attachments: z
		.array(emailAttachmentSchema)
		.max(20)
		.optional()
		.describe(
			"Optional file attachments (max 20 entries, 25MB total). Each entry must provide either `content` (base64-inline) or `url` (public URL for server-fetch). Use `contentId` for inline images.",
		),
	inReplyTo: z
		.string()
		.optional()
		.describe("Optional message ID to set the In-Reply-To header for threading."),
	references: z
		.array(z.string())
		.optional()
		.describe("Optional list of message IDs to include in the References header."),
});

const emailGetSchema = z.object({
	id: z.string().describe("Email ID. Returns full metadata and body."),
});

// 2026-07-17: `folder` and `offset` were fictional — GET /email accepts
// {agentId, cursor, limit} and Zod-strips everything else, so the server
// answered 200 with the unfiltered first page while the model believed it had
// asked for "sent" or for page 3. Replaced with the params the route really has.
const emailListSchema = z.object({
	agentId: z.string().optional().describe("Only return emails belonging to this agent."),
	cursor: z
		.string()
		.optional()
		.describe("Pagination cursor from a previous email_list response."),
	limit: z.number().int().positive().optional().describe("Max emails to return."),
});

const emailReplySchema = z.object({
	agentId: z.string().describe("Agent ID sending the reply."),
	originalId: z.string().describe("Original email ID being replied to."),
	text: z.string().describe("Plain-text content for your reply message."),
	html: z.string().optional().describe("Optional HTML content for the reply body."),
	replyAll: z
		.boolean()
		.optional()
		.describe("When true, include additional participants from the original email."),
	attachments: z
		.array(emailAttachmentSchema)
		.max(20)
		.optional()
		.describe("Optional file attachments on the reply (max 20 entries, 25MB total)."),
});

const emailForwardSchema = z.object({
	agentId: z.string().describe("Agent ID forwarding the email."),
	originalId: z.string().describe("Original email ID being forwarded."),
	to: z
		.array(z.string())
		.min(1)
		.describe("Recipient email address(es) for the forwarded message."),
	text: z
		.string()
		.optional()
		.describe("Optional introductory text to prepend before forwarded content."),
	attachments: z
		.array(emailAttachmentSchema)
		.max(20)
		.optional()
		.describe(
			"Optional additional file attachments on the forward (max 20 entries, 25MB total). Original email's attachments are NOT auto-included.",
		),
});

const emailSearchSchema = z.object({
	query: z
		.string()
		.min(1)
		.describe(
			"What to look for. In semantic mode this is a natural-language description of the message ('the invoice dispute from last week'); in fulltext mode it is matched literally against subject and body.",
		),
	mode: z
		.enum(["semantic", "fulltext"])
		.optional()
		.describe(
			"semantic (default): meaning-based vector search — finds messages that match the IDEA even with no shared keywords. fulltext: literal keyword match, for exact strings like an order number.",
		),
	agentId: z.string().optional().describe("Only search messages belonging to this agent."),
	direction: z
		.enum(["INBOUND", "OUTBOUND"])
		.optional()
		.describe("Restrict to received (INBOUND) or sent (OUTBOUND) mail. Fulltext mode only."),
	threshold: z
		.number()
		.min(0)
		.max(1)
		.optional()
		.describe(
			"Semantic mode only: minimum similarity, 0-1 (default 0.7). Lower to widen recall, raise to demand a closer match.",
		),
	limit: z.number().int().positive().max(50).optional().describe("Max results to return."),
});

const emailThreadGetSchema = z.object({
	id: z
		.string()
		.optional()
		.describe("Single thread ID to fetch. Pass either `id` or `ids`."),
	ids: z
		.array(z.string())
		.optional()
		.describe("Multiple thread IDs to fetch in parallel. Pass either `id` or `ids`."),
	agentId: z
		.string()
		.optional()
		.describe("Optional agent scope filter (only return messages owned by this agent)."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional max messages per thread."),
});

const emailAttachmentGetSchema = z.object({
	id: z.string().describe("Attachment ID. Returns a temporary download URL."),
});

const emailDraftCreateSchema = z.object({
	agentId: z.string().describe("Owning agent ID."),
	fromIdentityId: z
		.string()
		.optional()
		.describe(
			"Optional EmailIdentity ID to send from. Must belong to this agent and be verified. If omitted, the agent's primary identity is used at send time. Discover available IDs from the `emailIdentities` array returned by agent_get.",
		),
	to: z.array(z.string()).optional().describe("Recipient email addresses (may be empty for an incomplete draft)."),
	cc: z.array(z.string()).optional().describe("CC recipients."),
	bcc: z.array(z.string()).optional().describe("BCC recipients."),
	subject: z.string().optional().describe("Subject line."),
	body: z.string().optional().describe("Plain-text body."),
	bodyHtml: z.string().optional().describe("HTML body."),
	inReplyTo: z
		.string()
		.optional()
		.describe("Optional In-Reply-To Message-ID for threading on send."),
	references: z.array(z.string()).optional().describe("Optional References chain for threading."),
	metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata."),
});

const emailDraftListSchema = z.object({
	agentId: z.string().optional().describe("Filter drafts by agent ID."),
	cursor: z.string().optional().describe("Pagination cursor from a previous list response."),
	limit: z.number().int().positive().optional().describe("Max drafts to return."),
});

const emailDraftIdSchema = z.object({
	id: z.string().describe("Draft ID."),
});

export function registerEmailTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"email_send",
		{
			description:
				"Send a new outbound email from the agent mailbox. Use this when you need to compose and deliver a message with optional CC, threading headers.",
			inputSchema: emailSendSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = {
				agentId: args.agentId,
				to: args.to,
				subject: args.subject,
				body: args.body,
			};
			if (args.bodyHtml) body.bodyHtml = args.bodyHtml;
			if (args.cc) body.cc = args.cc;
			if (args.bcc) body.bcc = args.bcc;
			if (args.attachments && args.attachments.length > 0) {
				body.attachments = args.attachments;
			}
			if (args.inReplyTo) body.inReplyTo = args.inReplyTo;
			if (args.references) body.references = args.references;
			const result = await context.client.post<unknown>("/v1/email/send", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_get",
		{
			description:
				"Fetch full detail for a single email by ID, including metadata and body. Use email_list to browse emails in a folder.",
			inputSchema: emailGetSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/email/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_list",
		{
			description:
				"List emails with cursor pagination, optionally scoped to one agent. Returns lightweight per-email records — use email_get for the full body, or email_search to find a specific message by content. Ordering is not guaranteed: page with `cursor` rather than assuming the first page is the newest mail.",
			inputSchema: emailListSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/email?${params}` : "/v1/email";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_reply",
		{
			description:
				"Reply to an existing email thread by first loading the original message and setting threading headers. Use this when you need a proper in-thread response.",
			inputSchema: emailReplySchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			// 2026-07-17: dropped a hardcoded requireMasterKeyGuard here. Replying is
			// an ordinary agent action — email_send and email_forward make the very
			// same GET + POST /email/send calls with no guard, and MASTER_KEY_TOOLS
			// never listed email_reply. It only ever meant that anyone running the
			// stdio bridge without ANIMA_MASTER_KEY (i.e. the documented setup)
			// could send and forward mail but not reply.
			const originalPath = `/v1/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			// 2026-05-20: API returns fromAddress/toAddress (not from/to). For
			// OUTBOUND originals, "reply" should go to the original RECIPIENT
			// (toAddress), not the sender — replying to your own sent message
			// continues the thread with the same correspondent.
			const direction = typeof original.direction === "string"
				? original.direction
				: undefined;
			const isOutbound = direction === "OUTBOUND";
			const replyToAddress =
				extractEmailAddress(original.replyTo) ??
				(isOutbound
					? extractEmailAddress(original.toAddress) ?? extractEmailAddress(original.to)
					: extractEmailAddress(original.fromAddress) ?? extractEmailAddress(original.from));
			if (!replyToAddress) {
				throw new Error("Unable to determine reply recipient from original email.");
			}

			const subjectRaw =
				typeof original.subject === "string" ? original.subject : "No subject";
			const subject = ensureReplySubject(subjectRaw);

			const references = extractReferences(original);
			const inReplyTo = extractHeaderId(original);

			const payload: {
				agentId: string;
				to: string[];
				subject: string;
				body: string;
				bodyHtml?: string;
				cc?: string[];
				inReplyTo?: string;
				references?: string[];
				attachments?: unknown;
			} = {
				agentId: args.agentId,
				to: [replyToAddress],
				subject,
				body: args.text,
			};

			if (args.html) payload.bodyHtml = args.html;
			if (inReplyTo) payload.inReplyTo = inReplyTo;
			if (references.length > 0) payload.references = references;
			if (args.attachments && args.attachments.length > 0) {
				payload.attachments = args.attachments;
			}

			if (args.replyAll) {
				const ccList = dedupeStrings(
					[
						...extractStringArray(original.cc),
						...extractStringArray(original.to),
					].filter((address) => address !== replyToAddress),
				);

				if (ccList.length > 0) {
					payload.cc = ccList;
				}
			}

			const result = await context.client.post<unknown>("/v1/email/send", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_forward",
		{
			description:
				"Forward an existing email to another recipient by loading the original content first. Use this to share a prior message while preserving context.",
			inputSchema: emailForwardSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const originalPath = `/v1/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			const subjectRaw =
				typeof original.subject === "string" ? original.subject : "No subject";
			const subject = ensureForwardSubject(subjectRaw);

			// 2026-05-20: API uses fromAddress + body fields (not from/text/snippet).
			// Old code never matched and the forwarded body always said
			// "Original email body unavailable" / "From: unknown sender".
			const from =
				extractEmailAddress(original.fromAddress) ??
				extractEmailAddress(original.from) ??
				"unknown sender";
			const date = stringifyValue(
				original.sentAt ||
					original.receivedAt ||
					original.date ||
					original.createdAt ||
					"unknown date",
			);
			const originalText =
				typeof original.body === "string"
					? original.body
					: typeof original.text === "string"
						? original.text
						: typeof original.snippet === "string"
							? original.snippet
							: "(Original email body unavailable)";

			const intro = args.text ? `${args.text}\n\n` : "";
			const forwardedBody =
				`${intro}---------- Forwarded message ----------\n` +
				`From: ${from}\n` +
				`Date: ${date}\n` +
				`Subject: ${subjectRaw}\n\n` +
				`${originalText}`;

			const payload: {
				agentId: string;
				to: string[];
				subject: string;
				body: string;
				attachments?: unknown;
			} = {
				agentId: args.agentId,
				to: args.to,
				subject,
				body: forwardedBody,
			};

			if (args.attachments && args.attachments.length > 0) {
				payload.attachments = args.attachments;
			}

			const result = await context.client.post<unknown>("/v1/email/send", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_search",
		{
			description:
				"Search email by MEANING (default) or by literal keyword. Semantic mode uses vector search, so 'the invoice dispute' finds the message even when it never says 'invoice' or 'dispute' — use it when you know what a message was ABOUT but not what it said. Use fulltext mode for exact strings (order numbers, error codes). Prefer this over paging email_list when looking for something specific.",
			inputSchema: emailSearchSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const limit = args.limit ?? 20;

			if (args.mode === "fulltext") {
				const filters: Record<string, unknown> = { channel: "EMAIL" };
				if (args.agentId) filters.agentId = args.agentId;
				if (args.direction) filters.direction = args.direction;

				const result = await context.client.post<unknown>("/v1/messages/search", {
					query: args.query,
					filters,
					pagination: { limit },
				});
				return toolSuccess(result);
			}

			// Semantic. Unlike the fulltext route, /messages/search/semantic has no
			// channel filter — it ranks across every channel the org has. Narrowing
			// to EMAIL here keeps this tool true to its name, at the cost of
			// returning fewer than `limit` rows when SMS outranks mail. `direction`
			// is fulltext-only and is deliberately NOT applied client-side: silently
			// re-implementing a filter over a truncated top-N would drop matches the
			// caller had every reason to expect.
			const body: Record<string, unknown> = { query: args.query, limit };
			if (args.agentId) body.agentId = args.agentId;
			if (args.threshold !== undefined) body.threshold = args.threshold;

			const result = await context.client.post<unknown>(
				"/v1/messages/search/semantic",
				body,
			);

			const record = asRecord(result);
			const items = Array.isArray(record?.items) ? (record.items as unknown[]) : null;
			if (!items) return toolSuccess(result);

			const emails = items.filter((item) => asRecord(item)?.channel === "EMAIL");
			return toolSuccess({
				...record,
				items: emails,
				...(emails.length < items.length
					? {
							note: `${items.length - emails.length} non-email result(s) from other channels were dropped; re-run with a higher limit if you expected more.`,
						}
					: {}),
			});
		}, options.context),
	);

	server.registerTool(
		"email_thread_get",
		{
			description:
				"Fetch all email messages in one or more threads. Pass `id` for a single thread or `ids` for multiple. Returns messages ordered within each thread. Uses the messages endpoint filtered by threadId + channel=EMAIL under the hood.",
			inputSchema: emailThreadGetSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const threadIds = args.ids ?? (args.id ? [args.id] : []);
			if (threadIds.length === 0) {
				throw new Error("email_thread_get requires either `id` or `ids`.");
			}

			const fetchOne = async (threadId: string): Promise<unknown> => {
				const params = new URLSearchParams();
				params.set("threadId", threadId);
				params.set("channel", "EMAIL");
				if (args.agentId) params.set("agentId", args.agentId);
				if (args.limit !== undefined) params.set("limit", String(args.limit));
				return context.client.get<unknown>(`/v1/messages?${params}`);
			};

			const results = await Promise.all(threadIds.map(fetchOne));

			if (threadIds.length === 1) {
				return toolSuccess(results[0]);
			}

			return toolSuccess({
				threads: threadIds.map((id, i) => ({ id, ...((asRecord(results[i]) ?? {}) as object) })),
			});
		}, options.context),
	);

	server.registerTool(
		"email_attachment_get",
		{
			description:
				"Get a temporary download URL for an email attachment. Use this when you need direct file access for preview or download.",
			inputSchema: emailAttachmentGetSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/attachments/${encodeURIComponent(args.id)}/download`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_create",
		{
			description:
				"Create a new email draft (composed but not sent). Drafts can be incomplete — missing recipients, subject, or body. Use email_draft_send later to actually deliver, or email_draft_delete to discard.",
			inputSchema: emailDraftCreateSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = { agentId: args.agentId };
			if (args.fromIdentityId) body.fromIdentityId = args.fromIdentityId;
			if (args.to) body.to = args.to;
			if (args.cc) body.cc = args.cc;
			if (args.bcc) body.bcc = args.bcc;
			if (args.subject !== undefined) body.subject = args.subject;
			if (args.body !== undefined) body.body = args.body;
			if (args.bodyHtml !== undefined) body.bodyHtml = args.bodyHtml;
			if (args.inReplyTo !== undefined) body.inReplyTo = args.inReplyTo;
			if (args.references) body.references = args.references;
			if (args.metadata !== undefined) body.metadata = args.metadata;
			const result = await context.client.post<unknown>("/v1/email/drafts", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_get",
		{
			description:
				"Fetch full detail for a single draft by ID. Use email_draft_list to browse drafts.",
			inputSchema: emailDraftIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/email/drafts/${encodeURIComponent(args.id)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_list",
		{
			description:
				"List email drafts with optional filters. Returns lightweight draft records — use email_draft_get for full detail.",
			inputSchema: emailDraftListSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/email/drafts?${params}` : "/v1/email/drafts";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_send",
		{
			description:
				"Send a draft. Atomically converts the draft to a delivered Message + deletes the draft row. The draft must have at least one recipient, a subject, and a body. Returns the newly-created Message.",
			inputSchema: emailDraftIdSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				`/v1/email/drafts/${encodeURIComponent(args.id)}/send`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_delete",
		{
			description:
				"Discard a draft. Use this to remove drafts that are no longer needed. Use email_draft_send if you want to deliver instead.",
			inputSchema: emailDraftIdSchema.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			// API returns the deleted draft body for forensics. The MCP
			// surface normalizes all destructive ops to `{success: true}` —
			// matches webhook_delete, vault_credential_delete, etc.
			await context.client.delete<unknown>(
				`/v1/email/drafts/${encodeURIComponent(args.id)}`,
			);
			return toolSuccess({ success: true });
		}, options.context),
	);
}
