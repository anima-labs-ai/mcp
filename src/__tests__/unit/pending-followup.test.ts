import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
	activeFollowUpCount,
	cancelAllFollowUps,
	cancelFollowUp,
	drainFollowUps,
	scheduleFollowUp,
} from "../../pending-followup.js";

describe("pending follow-up scheduler", () => {
	afterEach(() => {
		cancelAllFollowUps();
	});

	test("scheduleFollowUp adds entry to tracked map", () => {
		scheduleFollowUp("p_1", "a@example.com", "Hello", async () => false);

		expect(activeFollowUpCount()).toBe(1);
	});

	test("activeFollowUpCount returns count for multiple tracked entries", () => {
		scheduleFollowUp("p_1", "a@example.com", "Subject A", async () => false);
		scheduleFollowUp("p_2", "b@example.com", "Subject B", async () => false);

		expect(activeFollowUpCount()).toBe(2);
	});

	test("cancelFollowUp removes specific entry", () => {
		scheduleFollowUp("p_1", "a@example.com", "A", async () => false);
		scheduleFollowUp("p_2", "b@example.com", "B", async () => false);

		const removed = cancelFollowUp("p_1");

		expect(removed).toBe(true);
		expect(activeFollowUpCount()).toBe(1);
		expect(cancelFollowUp("p_1")).toBe(false);
	});

	test("cancelAllFollowUps clears all tracked entries", () => {
		scheduleFollowUp("p_1", "a@example.com", "A", async () => false);
		scheduleFollowUp("p_2", "b@example.com", "B", async () => false);

		cancelAllFollowUps();

		expect(activeFollowUpCount()).toBe(0);
		expect(drainFollowUps()).toEqual([]);
	});

	test("drainFollowUps returns and clears queued notifications", async () => {
		const timeoutCallbacks: Array<() => unknown> = [];
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
			// biome-ignore lint/suspicious/noExplicitAny: timer mock requires flexible return type
			((...args: [unknown, ...unknown[]]) => {
				const handler = args[0];
				if (typeof handler === "function") {
					timeoutCallbacks.push(handler as () => unknown);
				}
				return 1 as never;
			}) as unknown as typeof setTimeout,
		);

		scheduleFollowUp("p_1", "user@example.com", "Blocked email", async () => false);

		expect(timeoutCallbacks.length).toBe(1);
		await timeoutCallbacks[0]?.();

		const firstDrain = drainFollowUps();
		expect(firstDrain).toHaveLength(1);
		expect(firstDrain[0]).toMatchObject({
			pendingId: "p_1",
			recipient: "user@example.com",
			subject: "Blocked email",
			attempt: 1,
			isFinalBeforeCooldown: false,
		});
		expect(firstDrain[0]?.message).toContain("Reminder");

		expect(drainFollowUps()).toEqual([]);

		timeoutSpy.mockRestore();
	});

	test("multiple schedules are tracked independently", () => {
		scheduleFollowUp("p_1", "a@example.com", "A", async () => false);
		scheduleFollowUp("p_2", "b@example.com", "B", async () => false);

		cancelFollowUp("p_2");

		expect(activeFollowUpCount()).toBe(1);
		expect(cancelFollowUp("p_1")).toBe(true);
		expect(activeFollowUpCount()).toBe(0);
	});

	test("duplicate pendingId replaces existing tracked timer", () => {
		const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");

		scheduleFollowUp("dup", "first@example.com", "First", async () => false);
		scheduleFollowUp("dup", "second@example.com", "Second", async () => false);

		expect(activeFollowUpCount()).toBe(1);
		expect(clearTimeoutSpy).toHaveBeenCalled();
	});

	test("when checkFn resolves true, follow-up is not enqueued", async () => {
		const timeoutCallbacks: Array<() => unknown> = [];
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
			// biome-ignore lint/suspicious/noExplicitAny: timer mock requires flexible return type
			((...args: [unknown, ...unknown[]]) => {
				const handler = args[0];
				if (typeof handler === "function") {
					timeoutCallbacks.push(handler as () => unknown);
				}
				return 1 as never;
			}) as unknown as typeof setTimeout,
		);

		scheduleFollowUp("resolved", "r@example.com", "Resolved", async () => true);
		await timeoutCallbacks[0]?.();

		expect(activeFollowUpCount()).toBe(0);
		expect(drainFollowUps()).toEqual([]);

		timeoutSpy.mockRestore();
	});
});
