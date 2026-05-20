import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../tool-helpers.js";

// 2026-05-20: vault group reduced to 7 credential-CRUD-plus-power tools.
// Dropped from prior surface: vault_provision, vault_deprovision (org-level
// lifecycle — operator concern), vault_generate_password (utility),
// vault_sync, vault_status (admin-y), vault_share_credential,
// vault_list_shares, vault_revoke_share (sharing — specialized),
// vault_create_token, vault_revoke_tokens (token issuance). Naming
// normalized to resource_action to match the rest of the surface
// (domain_get, agent_list, ...): vault_get_credential → vault_credential_get.

/**
 * Masks sensitive fields in a vault credential response.
 * Defence in depth: the API also masks, but MCP tool outputs are
 * surfaced to the LLM, and we don't want a plaintext secret to slip
 * through if a server version drifts. Invariant: "LLMs never see
 * plaintext through tools." Callers that need plaintext use the
 * autofill/proxy token flow at the credential-broker.
 *
 * Exported only for unit-testing the masking branches.
 */
export function maskCredentialFields(
	cred: Record<string, unknown>,
): Record<string, unknown> {
	const masked = { ...cred };

	if (masked.login && typeof masked.login === "object") {
		const login = { ...(masked.login as Record<string, unknown>) };
		if (login.password) login.password = "****";
		if (login.totp) login.totp = "****";
		masked.login = login;
	}

	if (masked.card && typeof masked.card === "object") {
		const card = { ...(masked.card as Record<string, unknown>) };
		if (card.code) card.code = "****";
		if (card.number && typeof card.number === "string") {
			card.number = `****${(card.number as string).slice(-4)}`;
		}
		masked.card = card;
	}

	if (masked.oauth && typeof masked.oauth === "object") {
		const oauth = { ...(masked.oauth as Record<string, unknown>) };
		if (oauth.accessToken) oauth.accessToken = "****";
		delete oauth.refreshToken;
		if (oauth.idToken) oauth.idToken = "****";
		masked.oauth = oauth;
	}

	if (masked.identity && typeof masked.identity === "object") {
		const identity = { ...(masked.identity as Record<string, unknown>) };
		if (identity.ssn) identity.ssn = "****";
		if (identity.passportNumber) identity.passportNumber = "****";
		if (identity.licenseNumber) identity.licenseNumber = "****";
		masked.identity = identity;
	}

	return masked;
}

const vaultCredentialTypeSchema = z.enum([
	"login",
	"secure_note",
	"card",
	"identity",
]);

const vaultUriSchema = z.object({
	uri: z.string().optional().describe("URI value."),
	match: z.string().optional().describe("Optional URI match mode."),
});

const vaultLoginSchema = z.object({
	username: z.string().optional().describe("Optional login username."),
	password: z.string().optional().describe("Optional login password."),
	uris: z
		.array(vaultUriSchema)
		.optional()
		.describe("Optional list of login URIs for this credential."),
	totp: z
		.string()
		.optional()
		.describe("Optional TOTP secret configured for this login."),
});

const vaultCardSchema = z.object({
	cardholderName: z.string().optional().describe("Optional cardholder name."),
	brand: z.string().optional().describe("Optional card brand."),
	number: z.string().optional().describe("Optional card number."),
	expMonth: z.string().optional().describe("Optional card expiration month."),
	expYear: z.string().optional().describe("Optional card expiration year."),
	code: z.string().optional().describe("Optional security code."),
});

const vaultIdentitySchema = z.object({
	title: z.string().optional().describe("Optional identity title."),
	firstName: z.string().optional().describe("Optional first name."),
	middleName: z.string().optional().describe("Optional middle name."),
	lastName: z.string().optional().describe("Optional last name."),
	address1: z.string().optional().describe("Optional address line 1."),
	address2: z.string().optional().describe("Optional address line 2."),
	address3: z.string().optional().describe("Optional address line 3."),
	city: z.string().optional().describe("Optional city."),
	state: z.string().optional().describe("Optional state or province."),
	postalCode: z.string().optional().describe("Optional postal code."),
	country: z.string().optional().describe("Optional country."),
	company: z.string().optional().describe("Optional company name."),
	email: z.string().optional().describe("Optional identity email address."),
	phone: z.string().optional().describe("Optional identity phone number."),
	ssn: z.string().optional().describe("Optional SSN or national ID."),
	username: z.string().optional().describe("Optional username value."),
	passportNumber: z.string().optional().describe("Optional passport number."),
	licenseNumber: z.string().optional().describe("Optional license number."),
});

const vaultFieldSchema = z.object({
	name: z.string().describe("Custom field name."),
	value: z.string().optional().describe("Optional custom field value."),
	type: z.string().optional().describe("Optional custom field type."),
	linkedId: z.string().optional().describe("Optional linked field identifier."),
});

const vaultListInput = z.object({
	agentId: z.string().describe("Agent ID whose vault credentials should be listed."),
	type: vaultCredentialTypeSchema
		.optional()
		.describe("Optional credential type filter."),
});

const vaultIdInput = z.object({
	id: z.string().describe("Credential ID."),
});

const vaultCreateInput = z.object({
	agentId: z.string().describe("Agent ID that owns the new credential."),
	type: vaultCredentialTypeSchema.describe("Credential type."),
	name: z.string().describe("Human-readable credential name."),
	login: vaultLoginSchema.optional().describe("Login payload for login-type credentials."),
	card: vaultCardSchema.optional().describe("Card payload for card-type credentials."),
	identity: vaultIdentitySchema.optional().describe("Identity payload for identity-type credentials."),
	notes: z.string().optional().describe("Optional secure note text."),
	fields: z.array(vaultFieldSchema).optional().describe("Optional custom fields."),
	favorite: z.boolean().optional().describe("Optional favorite flag."),
});

const vaultUpdateInput = z.object({
	id: z.string().describe("Credential ID to update."),
	name: z.string().optional().describe("Optional updated credential name."),
	login: vaultLoginSchema.optional().describe("Optional updated login payload."),
	card: vaultCardSchema.optional().describe("Optional updated card payload."),
	identity: vaultIdentitySchema.optional().describe("Optional updated identity payload."),
	notes: z.string().optional().describe("Optional updated secure note text."),
	fields: z.array(vaultFieldSchema).optional().describe("Optional updated custom fields."),
	favorite: z.boolean().optional().describe("Optional updated favorite flag."),
});

const vaultSearchInput = z.object({
	agentId: z.string().describe("Agent ID whose vault to search."),
	search: z.string().describe("Search text matched against credential names and content."),
	type: vaultCredentialTypeSchema
		.optional()
		.describe("Optional credential type filter."),
});

export function registerVaultTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"vault_credential_list",
		{
			description:
				"List credentials in an agent vault with optional type filter. Use this to browse stored secrets before reading, updating, or deleting entries. Sensitive fields in the response are masked.",
			inputSchema: vaultListInput.shape,
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
			params.set("agentId", args.agentId);
			if (args.type) params.set("type", args.type);
			const result = await context.client.get<unknown>(
				`/v1/vault/credentials?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_get",
		{
			description:
				"Get a single vault credential by ID. Sensitive fields (passwords, tokens, SSNs, CVV) are masked. To use the plaintext value for autofill or as an upstream credential, mint a vault token at the credential broker — the LLM never sees the secret directly.",
			inputSchema: vaultIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/vault/credentials/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<Record<string, unknown>>(path);
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.registerTool(
		"vault_credential_create",
		{
			description:
				"Create a new credential in an agent vault. Pass `type` plus the matching payload block (login / card / identity / notes). The response is masked — the caller already has the plaintext it just sent, so re-disclosing through MCP would only expose the LLM to its own input.",
			inputSchema: vaultCreateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<Record<string, unknown>>(
				"/v1/vault/credentials",
				args,
			);
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.registerTool(
		"vault_credential_update",
		{
			description:
				"Update an existing vault credential by ID. Use to rotate passwords or revise stored details. Response masked — caller already has plaintext for fields they just sent.",
			inputSchema: vaultUpdateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const { id, ...payload } = args;
			const path = `/v1/vault/credentials/${encodeURIComponent(id)}`;
			const result = await context.client.put<Record<string, unknown>>(path, payload);
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.registerTool(
		"vault_credential_delete",
		{
			description:
				"Delete a credential from vault storage by ID. Use this to remove obsolete or compromised secrets.",
			inputSchema: vaultIdInput.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/vault/credentials/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_search",
		{
			description:
				"Search vault credentials by keyword across names and content. Use this when you know part of the name, URL, or username but not the exact credential ID. Different access pattern from vault_credential_list — list is paginated browsing, search is text-query lookup.",
			inputSchema: vaultSearchInput.shape,
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
			params.set("agentId", args.agentId);
			params.set("search", args.search);
			if (args.type) params.set("type", args.type);
			const result = await context.client.get<unknown>(
				`/v1/vault/search?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_get_totp",
		{
			description:
				"Get the current TOTP code for a credential that has a TOTP secret configured. Use for time-based one-time passcode login flows. Returns the live 6-digit code derived from the stored secret — the secret itself is never disclosed.",
			inputSchema: vaultIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/vault/totp/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);
}
