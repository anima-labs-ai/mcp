import type { ToolRegistrationOptions } from "./tool-helpers.js";
import { registerAgentTools } from "./tools/agent/index.js";
import { registerDomainTools } from "./tools/domain/index.js";
import { registerEmailTools } from "./tools/email/index.js";
import { registerPhoneTools } from "./tools/phone/index.js";
import { registerPhoneCallTools } from "./tools/phone_call/index.js";
import { registerProvisioningTools } from "./tools/provisioning/index.js";
import { registerSmsTools } from "./tools/sms/index.js";
import { registerVaultTools } from "./tools/vault/index.js";
import { registerWebhookTools } from "./tools/webhook/index.js";
import { registerWorkspaceTools } from "./tools/workspace/index.js";

/**
 * Map of tool group names to their registration functions.
 *
 * Lives here rather than in index.ts because index.ts is the executable
 * entrypoint: importing it runs main(), which resolves an API key and exits.
 * Tests need this map, so it has to be reachable without that side effect.
 *
 * Iterate this instead of hand-listing registrars. A hand-listed copy silently
 * drops any group added later — the "all domains combined" registration test
 * missed `provisioning` for exactly that reason and kept asserting the old
 * tool count while CI stayed green.
 */
export const TOOL_GROUPS: Record<
	string,
	(options: ToolRegistrationOptions) => void
> = {
	agent: registerAgentTools,
	email: registerEmailTools,
	domain: registerDomainTools,
	phone: registerPhoneTools,
	sms: registerSmsTools,
	vault: registerVaultTools,
	provisioning: registerProvisioningTools,
	webhook: registerWebhookTools,
	workspace: registerWorkspaceTools,
	phone_call: registerPhoneCallTools,
};
