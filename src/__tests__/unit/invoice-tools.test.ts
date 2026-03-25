import { describe, test, expect, mock } from "bun:test";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../../api-client.js";
import type { ToolContext, ToolRegistrationOptions } from "../../tool-helpers.js";
import { registerInvoiceTools } from "../../tools/invoice/index.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
};

type RegisteredTool = {
	description: string;
	schema: unknown;
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

type MockApiClient = {
	get: ReturnType<typeof mock>;
	post: ReturnType<typeof mock>;
	patch: ReturnType<typeof mock>;
	put: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
	hasMasterKey: () => boolean;
};

function createHarness(): {
	registeredTools: Map<string, RegisteredTool>;
	client: MockApiClient;
	options: ToolRegistrationOptions;
} {
	const registeredTools = new Map<string, RegisteredTool>();
	const client: MockApiClient = {
		get: mock(() => Promise.resolve({ ok: true })),
		post: mock(() => Promise.resolve({ ok: true })),
		patch: mock(() => Promise.resolve({ ok: true })),
		put: mock(() => Promise.resolve({ ok: true })),
		delete: mock(() => Promise.resolve({ ok: true })),
		hasMasterKey: () => true,
	};

	const server = {
		tool: mock(
			(
				name: string,
				description: string,
				schema: unknown,
				handler: RegisteredTool["handler"],
			) => {
				registeredTools.set(name, { description, schema, handler });
			},
		),
		resource: mock(() => undefined),
	} as unknown as McpServer;

	const context: ToolContext = {
		client: client as unknown as ApiClient,
		hasMasterKey: true,
	};

	return {
		registeredTools,
		client,
		options: { server, context },
	};
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
	const tool = tools.get(name);
	expect(tool).toBeDefined();
	if (!tool) {
		throw new Error(`Tool not registered: ${name}`);
	}
	return tool;
}

function getSchema(tools: Map<string, RegisteredTool>, name: string): z.ZodObject<z.ZodRawShape> {
	const tool = getTool(tools, name);
	return z.object(tool.schema as z.ZodRawShape);
}

function parsePayload(result: ToolResult): unknown {
	const text = result.content[0]?.text ?? "";
	return JSON.parse(text) as unknown;
}

describe("invoice MCP tools", () => {
	test("registers all invoice tools", () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);

		expect([...harness.registeredTools.keys()].sort()).toEqual(
			[
				"invoice_process",
				"invoice_auto_pay",
				"invoice_reconcile",
			].sort(),
		);
	});

	test("invoice_process schema requires invoice_id", () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);

		const schema = getSchema(harness.registeredTools, "invoice_process");
		const result = schema.safeParse({});
		expect(result.success).toBe(false);
	});

	test("invoice_process schema applies boolean defaults", () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);

		const schema = getSchema(harness.registeredTools, "invoice_process");
		const result = schema.parse({ invoice_id: "inv_1" });

		expect(result.confirm).toBe(false);
		expect(result.create_card).toBe(false);
		expect(result.dry_run).toBe(true);
	});

	test("invoice_auto_pay schema requires invoice_id and defaults dry_run", () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);

		const schema = getSchema(harness.registeredTools, "invoice_auto_pay");
		expect(schema.safeParse({}).success).toBe(false);
		expect(schema.parse({ invoice_id: "inv_2" }).dry_run).toBe(true);
	});

	test("invoice_reconcile schema defaults threshold and dry_run", () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);

		const schema = getSchema(harness.registeredTools, "invoice_reconcile");
		const result = schema.parse({});

		expect(result.auto_link_threshold).toBe(0.7);
		expect(result.dry_run).toBe(true);
		expect(result.receipt_ids).toBeUndefined();
		expect(result.invoice_ids).toBeUndefined();
	});

	test("invoice_reconcile schema rejects threshold out of range", () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);

		const schema = getSchema(harness.registeredTools, "invoice_reconcile");
		expect(schema.safeParse({ auto_link_threshold: -0.01 }).success).toBe(false);
		expect(schema.safeParse({ auto_link_threshold: 1.01 }).success).toBe(false);
	});

	test("invoice_process dry run fetches invoice and returns preview", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.get.mockResolvedValueOnce({ id: "inv_1", status: "detected" });

		const handler = getTool(harness.registeredTools, "invoice_process").handler;
		const result = await handler({ invoice_id: "inv_1" });
		const payload = parsePayload(result) as {
			dryRun: boolean;
			actions: { confirm: boolean; createCard: boolean };
		};

		expect(harness.client.get).toHaveBeenCalledWith("/api/v1/invoices/inv_1");
		expect(harness.client.patch).not.toHaveBeenCalled();
		expect(harness.client.post).not.toHaveBeenCalled();
		expect(payload.dryRun).toBe(true);
		expect(payload.actions).toEqual({ confirm: false, createCard: false });
	});

	test("invoice_process confirms invoice when confirm=true", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.get.mockResolvedValueOnce({ id: "inv_2", status: "detected" });
		harness.client.patch.mockResolvedValueOnce({ id: "inv_2", status: "confirmed" });

		const handler = getTool(harness.registeredTools, "invoice_process").handler;
		const result = await handler({ invoice_id: "inv_2", confirm: true, dry_run: false });
		const payload = parsePayload(result) as {
			dryRun: boolean;
			confirmedInvoice: { status: string };
		};

		expect(harness.client.patch).toHaveBeenCalledWith("/api/v1/invoices/inv_2", { status: "confirmed" });
		expect(harness.client.post).not.toHaveBeenCalled();
		expect(payload.dryRun).toBe(false);
		expect(payload.confirmedInvoice.status).toBe("confirmed");
	});

	test("invoice_process creates card when create_card=true", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.get.mockResolvedValueOnce({ id: "inv_3", status: "detected" });
		harness.client.post.mockResolvedValueOnce({ cardId: "card_1" });

		const handler = getTool(harness.registeredTools, "invoice_process").handler;
		const result = await handler({ invoice_id: "inv_3", create_card: true, dry_run: false });
		const payload = parsePayload(result) as {
			createdCard: { cardId: string };
		};

		expect(harness.client.patch).not.toHaveBeenCalled();
		expect(harness.client.post).toHaveBeenCalledWith("/api/v1/invoices/inv_3/card", {});
		expect(payload.createdCard.cardId).toBe("card_1");
	});

	test("invoice_process runs both confirm and create_card actions", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.get.mockResolvedValueOnce({ id: "inv_4", status: "detected" });
		harness.client.patch.mockResolvedValueOnce({ id: "inv_4", status: "confirmed" });
		harness.client.post.mockResolvedValueOnce({ cardId: "card_2" });

		const handler = getTool(harness.registeredTools, "invoice_process").handler;
		await handler({ invoice_id: "inv_4", confirm: true, create_card: true, dry_run: false });

		expect(harness.client.patch).toHaveBeenCalledWith("/api/v1/invoices/inv_4", { status: "confirmed" });
		expect(harness.client.post).toHaveBeenCalledWith("/api/v1/invoices/inv_4/card", {});
	});

	test("invoice_process encodes invoice ID in API path", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.get.mockResolvedValueOnce({ id: "inv/with space" });

		const handler = getTool(harness.registeredTools, "invoice_process").handler;
		await handler({ invoice_id: "inv/with space" });

		expect(harness.client.get).toHaveBeenCalledWith("/api/v1/invoices/inv%2Fwith%20space");
	});

	test("invoice_process wraps client errors as MCP errors", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.get.mockRejectedValueOnce(new Error("invoice not found"));

		const handler = getTool(harness.registeredTools, "invoice_process").handler;
		const result = await handler({ invoice_id: "missing" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("Error: invoice not found");
	});

	test("invoice_auto_pay dry run fetches invoice and returns plan", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.get.mockResolvedValueOnce({
			id: "inv_5",
			amountCents: 12345,
			currency: "usd",
			cardInfo: { id: "card_5" },
		});

		const handler = getTool(harness.registeredTools, "invoice_auto_pay").handler;
		const result = await handler({ invoice_id: "inv_5" });
		const payload = parsePayload(result) as {
			dryRun: boolean;
			paymentPlan: { amount: number; currency: string; card: { id: string } };
		};

		expect(harness.client.get).toHaveBeenCalledWith("/api/v1/invoices/inv_5");
		expect(harness.client.post).not.toHaveBeenCalled();
		expect(payload.dryRun).toBe(true);
		expect(payload.paymentPlan.amount).toBe(12345);
		expect(payload.paymentPlan.currency).toBe("usd");
		expect(payload.paymentPlan.card.id).toBe("card_5");
	});

	test("invoice_auto_pay enqueues payment job when dry_run=false", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.post.mockResolvedValueOnce({ jobId: "job_1", state: "queued" });

		const handler = getTool(harness.registeredTools, "invoice_auto_pay").handler;
		const result = await handler({ invoice_id: "inv_6", dry_run: false });
		const payload = parsePayload(result) as {
			status: string;
			queued: boolean;
			result: { jobId: string };
		};

		expect(harness.client.post).toHaveBeenCalledWith("/api/v1/invoices/inv_6/auto-pay", {});
		expect(payload.status).toBe("queued");
		expect(payload.queued).toBe(true);
		expect(payload.result.jobId).toBe("job_1");
	});

	test("invoice_auto_pay wraps errors", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.post.mockRejectedValueOnce(new Error("auto-pay unavailable"));

		const handler = getTool(harness.registeredTools, "invoice_auto_pay").handler;
		const result = await handler({ invoice_id: "inv_7", dry_run: false });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("Error: auto-pay unavailable");
	});

	test("invoice_reconcile dry run posts default reconciliation body", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.post.mockResolvedValueOnce({ matches: [], exceptions: [], unmatched: [] });

		const handler = getTool(harness.registeredTools, "invoice_reconcile").handler;
		await handler({});

		expect(harness.client.post).toHaveBeenCalledWith("/api/v1/invoices/match-receipts", {
			receipts: [],
			autoLinkThreshold: 0.7,
			dryRun: true,
		});
	});

	test("invoice_reconcile forwards provided IDs and threshold without dryRun", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.post.mockResolvedValueOnce({ matches: [{ id: "m_1" }], exceptions: [], unmatched: [] });

		const handler = getTool(harness.registeredTools, "invoice_reconcile").handler;
		await handler({
			receipt_ids: ["rcpt_1", "rcpt_2"],
			invoice_ids: ["inv_8"],
			auto_link_threshold: 0.85,
			dry_run: false,
		});

		expect(harness.client.post).toHaveBeenCalledWith("/api/v1/invoices/match-receipts", {
			receipts: ["rcpt_1", "rcpt_2"],
			invoiceIds: ["inv_8"],
			autoLinkThreshold: 0.85,
		});
	});

	test("invoice_reconcile returns API match payload", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.post.mockResolvedValueOnce({
			matches: [{ receiptId: "rcpt_3", invoiceId: "inv_9", confidence: 0.91 }],
			exceptions: [{ receiptId: "rcpt_4" }],
			unmatched: ["rcpt_5"],
		});

		const handler = getTool(harness.registeredTools, "invoice_reconcile").handler;
		const result = await handler({ receipt_ids: ["rcpt_3"] });
		const payload = parsePayload(result) as {
			matches: Array<{ receiptId: string; invoiceId: string; confidence: number }>;
			exceptions: Array<{ receiptId: string }>;
			unmatched: string[];
		};

		expect(payload.matches[0]?.invoiceId).toBe("inv_9");
		expect(payload.exceptions[0]?.receiptId).toBe("rcpt_4");
		expect(payload.unmatched).toEqual(["rcpt_5"]);
	});

	test("invoice_reconcile wraps errors", async () => {
		const harness = createHarness();
		registerInvoiceTools(harness.options);
		harness.client.post.mockRejectedValueOnce(new Error("reconcile failed"));

		const handler = getTool(harness.registeredTools, "invoice_reconcile").handler;
		const result = await handler({ dry_run: false });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("Error: reconcile failed");
	});
});
