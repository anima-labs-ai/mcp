import { z } from "zod";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
	type ToolRegistrationOptions,
} from "../../tool-helpers.js";

const setupExtensionSchema = z.object({
	agentId: z
		.string()
		.optional()
		.describe("Agent ID requesting extension auth. Required for pre_approved policy."),
});

const updateExtensionSettingsSchema = z.object({
	authPolicy: z
		.enum(["session", "pre_approved", "prompt_owner"])
		.optional()
		.describe("Auth policy: session (default), pre_approved, or prompt_owner"),
	preApprovedAgentIds: z
		.array(z.string())
		.optional()
		.describe("Agent IDs allowed to silently authenticate (for pre_approved policy)"),
});

export function registerExtensionTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"setup_extension",
		[
			"Generate an auth token for the Anima Vault browser extension and get a URL to connect it.",
			"",
			"This creates a session-scoped API key that authenticates the extension to the WebSocket bridge.",
			"Open the returned connectUrl in the user's browser to complete the connection.",
			"",
			"The token lifecycle depends on the org's extension auth policy:",
			"  - session (default): Token lives until browser closes",
			"  - pre_approved: Only allowed agents can authenticate silently",
			"  - prompt_owner: Owner must approve in the extension popup",
		].join("\n"),
		setupExtensionSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);

			const result = await context.client.post<{
				token: string;
				policy: string;
				requiresApproval: boolean;
				expiresAt: string | null;
				connectUrl: string;
			}>("/extension/token", {
				agentId: args.agentId,
			});

			return toolSuccess({
				message: result.requiresApproval
					? "Token created. The owner must approve this auth attempt in the extension popup."
					: "Token created. Open the connectUrl in the browser to authenticate the extension.",
				token: result.token,
				policy: result.policy,
				requiresApproval: result.requiresApproval,
				connectUrl: result.connectUrl,
				instructions: [
					"1. Open the connectUrl in the user's browser",
					"2. The page will detect the extension and send the auth token",
					"3. The extension will connect to the WebSocket bridge automatically",
					result.requiresApproval
						? "4. The owner must click 'Approve' in the extension popup"
						: "4. No further action needed — extension is ready",
				],
			});
		}, options.context),
	);

	server.tool(
		"get_extension_settings",
		"Get the current extension auth settings for the organization.",
		z.object({}).shape,
		withErrorHandling(async (_args, context) => {
			requireMasterKeyGuard(context);

			const result = await context.client.get<{
				authPolicy: string;
				preApprovedAgentIds: string[];
			}>("/extension/settings");

			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"update_extension_settings",
		[
			"Update the extension auth settings for the organization.",
			"",
			"Auth policies:",
			"  - session: Agent gets a session-scoped token, cleared when browser closes (default)",
			"  - pre_approved: Only agents in the pre-approved list can authenticate silently",
			"  - prompt_owner: Owner must approve every auth attempt in the extension popup",
		].join("\n"),
		updateExtensionSettingsSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);

			const result = await context.client.patch<{
				authPolicy: string;
				preApprovedAgentIds: string[];
			}>("/extension/settings", args);

			return toolSuccess(result);
		}, options.context),
	);
}
