import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import { objectOutput, toolSuccess, withErrorHandling } from "../../tool-helpers.js";

// 2026-05-20: utility group reduced to two self-introspection tools.
// Anything message-shaped (messages_check, tasks_check, spam_manage,
// pending_manage), inter-agent (agent_message, agent_call), MCP-stateful
// (followups_check, email_wait), or generic-debug (health_check) was
// dropped to keep this group focused on "what is my workspace?" reads.
// Earlier removals: whoami + me_update (folded into account_overview;
// me_update had a design bug). setup_email_domain + send_test_email
// removed 2026-05-13 as dupes of domain_add + email_send.

const noInput = z.object({});

const usageOverviewInput = z.object({
	period: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.optional()
		.describe(
			"Billing period in YYYY-MM format (e.g. '2026-05'). Defaults to the current calendar month in UTC.",
		),
});

function registerAccountOverviewTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"account_overview",
		{
			description:
				"Single-call workspace snapshot: organization context, credential identity, send-capability flags (canSendEmail / canSendSms), inventory counts (agents, domains, phones), and active blockers. Strict superset of the legacy whoami + workspace_health pair. Use this before any non-trivial workflow to answer 'who am I and can I do X right now?' without paying a real send to find out.",
			inputSchema: noInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (_args, context) => {
			// Two parallel reads: /orgs/me gives the full org profile
			// (slug, settings, keyRotatedAt) while /orgs/me/workspace-health
			// gives status, capabilities, inventory, blockers, and the
			// auth-context block that whoami used to surface. Merging at
			// the MCP layer avoids adding a third API endpoint just to
			// reshape the response.
			const [org, health] = await Promise.all([
				context.client.get<Record<string, unknown>>("/v1/orgs/me"),
				context.client.get<Record<string, unknown>>("/v1/orgs/me/workspace-health"),
			]);

			return toolSuccess({
				...health,
				organization: {
					id: org.id,
					name: org.name,
					slug: org.slug,
					tier: org.tier,
					keyRotatedAt: org.keyRotatedAt,
					createdAt: org.createdAt,
				},
			});
		}, options.context),
	);
}

function registerUsageOverviewTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"usage_overview",
		{
			description:
				"Usage rollup for a billing period. Returns counters keyed by usage type (e.g. 'email_sent', 'sms_sent', 'voice_call_minutes') plus the latest update timestamp. Defaults to the current calendar month in UTC when `period` is omitted. Use to answer 'where am I against my tier limits?' without paying for per-event detail.",
			inputSchema: usageOverviewInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.period) params.set("period", args.period);
			const qs = params.toString();
			const url = qs ? `/v1/orgs/me/usage?${qs}` : "/v1/orgs/me/usage";
			const result = await context.client.get(url);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerUtilityTools(options: ToolRegistrationOptions): void {
	registerAccountOverviewTool(options);
	registerUsageOverviewTool(options);
}
