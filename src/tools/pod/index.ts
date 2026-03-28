import { z } from "zod";
import type { ToolRegistrationOptions } from "../../tool-helpers.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
} from "../../tool-helpers.js";

const createPodSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent to create the pod for."),
	name: z
		.string()
		.describe("Name for the pod."),
	image: z
		.string()
		.describe("Container image to run (e.g. 'node:20-alpine')."),
	resources: z
		.object({
			cpu: z.string().optional().describe("CPU allocation (e.g. '0.5', '1')."),
			memory: z.string().optional().describe("Memory allocation (e.g. '256Mi', '1Gi')."),
			storage: z.string().optional().describe("Storage allocation (e.g. '1Gi', '10Gi')."),
		})
		.optional()
		.describe("Resource specifications for the pod."),
	env: z
		.record(z.string())
		.optional()
		.describe("Environment variables for the container."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Optional metadata for the pod."),
});

const listPodsSchema = z.object({
	agentId: z
		.string()
		.optional()
		.describe("Optional agent ID to filter pods by."),
});

const podIdSchema = z.object({
	id: z
		.string()
		.describe("Pod ID."),
});

const updatePodSchema = z.object({
	id: z
		.string()
		.describe("Pod ID to update."),
	name: z
		.string()
		.optional()
		.describe("Updated pod name."),
	resources: z
		.object({
			cpu: z.string().optional().describe("Updated CPU allocation."),
			memory: z.string().optional().describe("Updated memory allocation."),
			storage: z.string().optional().describe("Updated storage allocation."),
		})
		.optional()
		.describe("Updated resource specifications."),
	env: z
		.record(z.string())
		.optional()
		.describe("Updated environment variables."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Updated metadata."),
});

export function registerPodTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"create_pod",
		"Create a new compute pod for an agent. Use this to provision a container that runs alongside the agent.",
		createPodSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/pods", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"list_pods",
		"List all compute pods, optionally filtered by agent. Use this to see running and stopped pods.",
		listPodsSchema.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			const qs = params.toString();
			const path = `/pods${qs ? `?${qs}` : ""}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"get_pod",
		"Get details for a specific pod. Use this to check pod status, resources, and configuration.",
		podIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/pods/${encodeURIComponent(args.id)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"update_pod",
		"Update a pod's configuration. Use this to change resources, environment variables, or metadata.",
		updatePodSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const { id, ...body } = args;
			const result = await context.client.put<unknown>(`/pods/${encodeURIComponent(id)}`, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"delete_pod",
		"Delete a compute pod. Use this to tear down a pod that is no longer needed.",
		podIdSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.delete<unknown>(`/pods/${encodeURIComponent(args.id)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"pod_usage",
		"Get resource usage metrics for a pod. Use this to monitor CPU, memory, storage, and network usage.",
		podIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/pods/${encodeURIComponent(args.id)}/usage`);
			return toolSuccess(result);
		}, options.context),
	);
}
