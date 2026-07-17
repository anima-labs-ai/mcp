/**
 * Tool → contract-route declarations. The source of truth for the M2/M3 CI gates
 * (`src/__tests__/integration/contract-parity.test.ts`).
 *
 * WHY THIS EXISTS
 * This bridge is a thin client over the Anima REST API. Two failure modes are
 * invisible to ordinary tests, because a tool that lies still returns 200:
 *
 *   M2 — a tool calls a route that does not exist (shipped ahead of the API, or
 *        the API moved). The LLM gets a 404 it cannot act on.
 *   M3 — a tool advertises a parameter the backing route does not accept. The
 *        server Zod-STRIPS it, returns 200, and the LLM believes the filter was
 *        applied. `email_list.folder`/`.offset` did exactly this.
 *
 * Both gates check these declarations against `__tests__/fixtures/contract-routes.json`,
 * a snapshot of the real `@anima/contracts` route surface. See
 * `scripts/generate-contract-manifest.ts` for how it is produced and refreshed.
 *
 * RULES
 * - `routes` uses the CONTRACT path (bare — the API mounts everything under /v1)
 *   and must match a manifest key exactly. Composed tools list EVERY primitive
 *   route they call, not just the headline one.
 * - `paramAliases` maps a tool param onto the contract param it is actually SENT
 *   as. What matters is the key on the wire, not the name the LLM sees: the tool
 *   surfaces `status` but sends `state`, so `status` is honest. The gate resolves
 *   the TARGET against the contract, which is why aliasing cannot launder a
 *   fictional param — `numberId -> phoneIdentityId` fails, because the route has
 *   no `phoneIdentityId`. Path placeholders are covered here too: oRPC puts them
 *   in the route's input schema, so `id -> callId` binds like any other param.
 * - `clientParams` is for params the bridge implements ITSELF and never forwards
 *   under any name. Each entry states WHY. This is the only escape hatch, and it
 *   is not a place to silence M3 — if a param is meant to reach the server and
 *   does not, that is the bug the gate just found.
 */

export interface ToolContractDeclaration {
	/** Contract routes this tool calls, as "METHOD /path" manifest keys. */
	readonly routes: readonly string[];
	/** Tool param -> the contract param it is sent as, where the names differ. */
	readonly paramAliases?: Readonly<Record<string, string>>;
	/** Tool param -> why it is handled client-side and never sent to a route. */
	readonly clientParams?: Readonly<Record<string, string>>;
}

export const TOOL_CONTRACTS: Readonly<Record<string, ToolContractDeclaration>> = {
	// ---- agent ----
	agent_create: {
		// Composed: creates the agent, then optionally its postal address.
		routes: ["POST /agents", "POST /addresses"],
		clientParams: {
			address:
				"Bridge-side composition: a nested object destructured into the POST /addresses body after the agent exists.",
		},
	},
	agent_get: {
		// Composed: agent record + its addresses, merged into one payload.
		routes: ["GET /agents/{id}", "GET /addresses"],
	},
	agent_list: {
		routes: ["GET /agents"],
	},
	agent_update: {
		// Composed: patches the agent and reconciles address add/update/remove.
		routes: [
			"GET /agents/{id}",
			"PATCH /agents/{id}",
			"POST /addresses",
			"PUT /addresses/{id}",
			"DELETE /addresses/{id}",
		],
		clientParams: {
			addAddress:
				"Bridge-side composition: nested object destructured into the POST /addresses body.",
			updateAddress:
				"Bridge-side composition: nested object carrying addressId + the PUT /addresses/{id} body.",
			deleteAddressId:
				"Bridge-side verb: selects the DELETE /addresses/{id} target; sent in the path, not the body.",
		},
	},
	agent_delete: {
		routes: ["DELETE /agents/{id}"],
	},

	// ---- domain ----
	domain_create: { routes: ["POST /domains"] },
	domain_verify: { routes: ["POST /domains/{id}/verify"] },
	domain_get: { routes: ["GET /domains/{id}"] },
	domain_list: { routes: ["GET /domains"] },
	domain_delete: { routes: ["DELETE /domains/{id}"] },
	domain_update: { routes: ["PATCH /domains/{id}"] },
	domain_zone_file: { routes: ["GET /domains/{id}/zone-file"] },

	// ---- email ----
	email_send: { routes: ["POST /email/send"] },
	email_get: { routes: ["GET /email/{id}"] },
	email_list: { routes: ["GET /email"] },
	email_reply: {
		// Composed: loads the original to derive recipient + threading headers,
		// then sends.
		routes: ["GET /email/{id}", "POST /email/send"],
		paramAliases: { text: "body", html: "bodyHtml" },
		clientParams: {
			originalId:
				"Bridge-side: selects the GET /email/{id} original; its id goes in the path, never the send body.",
			replyAll:
				"Bridge-side: derives the send body's `cc` from the original's participants.",
		},
	},
	email_forward: {
		// Composed: loads the original, renders a quoted body, then sends.
		routes: ["GET /email/{id}", "POST /email/send"],
		clientParams: {
			originalId:
				"Bridge-side: selects the GET /email/{id} original; its id goes in the path, never the send body.",
			text: "Bridge-side: intro text prepended to the rendered forward body.",
		},
	},
	email_search: {
		// Composed: one tool over two backing routes, chosen by `mode`.
		routes: ["POST /messages/search", "POST /messages/search/semantic"],
		clientParams: {
			mode: "Bridge-side switch: picks fulltext (POST /messages/search) vs semantic (POST /messages/search/semantic).",
			direction:
				"Bridge-side reshape: nested into the fulltext route's `filters` object rather than sent flat.",
		},
	},
	email_thread_get: {
		// Composed: fans out one /messages read per threadId.
		routes: ["GET /messages"],
		paramAliases: { id: "threadId" },
		clientParams: {
			ids: "Bridge-side fan-out: one GET /messages call per thread, results merged.",
		},
	},
	email_attachment_get: { routes: ["GET /attachments/{id}/download"] },
	email_draft_create: { routes: ["POST /email/drafts"] },
	email_draft_get: { routes: ["GET /email/drafts/{id}"] },
	email_draft_list: { routes: ["GET /email/drafts"] },
	email_draft_send: { routes: ["POST /email/drafts/{id}/send"] },
	email_draft_delete: { routes: ["DELETE /email/drafts/{id}"] },

	// ---- phone ----
	phone_number_list: { routes: ["GET /phone/numbers"] },
	phone_number_provision: { routes: ["POST /phone/provision"] },
	phone_number_release: { routes: ["POST /phone/release"] },

	// ---- phone_call ----
	phone_call_create: { routes: ["POST /voice/calls"] },
	phone_call_list: {
		routes: ["GET /voice/calls"],
		// The tool surfaces `status` but sends `state`, which is the real filter.
		paramAliases: { status: "state" },
	},
	phone_call_get: {
		routes: ["GET /voice/calls/{callId}"],
		paramAliases: { id: "callId" },
	},
	phone_call_transcript_get: {
		routes: ["GET /voice/calls/{callId}/transcript"],
		paramAliases: { id: "callId" },
	},
	phone_call_recording_get: {
		routes: ["GET /voice/calls/{callId}/recording"],
		paramAliases: { id: "callId" },
	},
	voice_list: { routes: ["GET /voice/catalog"] },

	// ---- sms ----
	sms_get: { routes: ["GET /messages/{id}"] },
	sms_list: { routes: ["GET /messages"] },
	sms_thread_list: {
		// Composed: there is no /sms/threads route — a page of messages is
		// fetched, then grouped and paginated bridge-side.
		routes: ["GET /messages"],
		clientParams: {
			offset:
				"Bridge-side pagination: slices the locally-aggregated thread list; the fetch itself is a fixed-size page.",
		},
	},
	sms_thread_get: {
		routes: ["GET /messages"],
		paramAliases: { id: "threadId" },
	},
	sms_send: { routes: ["POST /phone/send-sms"] },

	// ---- vault ----
	vault_provision: { routes: ["POST /vault/provision"] },
	vault_credential_list: { routes: ["GET /vault/credentials"] },
	vault_credential_get: { routes: ["GET /vault/credentials/{id}"] },
	vault_credential_create: { routes: ["POST /vault/credentials"] },
	vault_credential_update: { routes: ["PUT /vault/credentials/{id}"] },
	vault_credential_delete: { routes: ["DELETE /vault/credentials/{id}"] },
	vault_credential_search: { routes: ["GET /vault/search"] },
	vault_credential_get_totp: { routes: ["GET /vault/totp/{id}"] },

	// ---- webhook ----
	webhook_get: { routes: ["GET /webhooks/{id}"] },
	webhook_list: { routes: ["GET /webhooks"] },
	webhook_set: {
		// Upsert: PUT when `id` is supplied, POST otherwise.
		routes: ["POST /webhooks", "PUT /webhooks/{id}"],
	},
	webhook_delete: { routes: ["DELETE /webhooks/{id}"] },
	webhook_test: { routes: ["POST /webhooks/{id}/test"] },

	// ---- workspace ----
	account_overview: {
		// Composed: org profile + workspace health, merged into one snapshot.
		routes: ["GET /orgs/me", "GET /orgs/me/workspace-health"],
	},
	usage_overview: { routes: ["GET /orgs/me/usage"] },
};
