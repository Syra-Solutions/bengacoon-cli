import { describe, expect, it } from "vitest";
import { createBengacoonStatusSnapshot } from "../src/core/bengacoon-status.ts";
import type { ExtensionStatusMetadata } from "../src/core/footer-data-provider.ts";

describe("Bengacoon status snapshot", () => {
	it("combines branch, usage, remaining context, jobs, and provider quota", () => {
		const snapshot = createBengacoonStatusSnapshot(
			{
				getSessionStats: () => ({
					sessionFile: undefined,
					sessionId: "session-1",
					userMessages: 1,
					assistantMessages: 1,
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 2,
					tokens: { input: 1200, output: 300, cacheRead: 500, cacheWrite: 0, total: 2000 },
					cost: 0.42,
					contextUsage: { tokens: 250, contextWindow: 1000, percent: 25 },
				}),
			},
			{
				getGitBranch: () => "feat/sidebar",
				getExtensionStatusMetadata: () =>
					new Map<string, ExtensionStatusMetadata>([
						[
							"bengacoon-jobs",
							{
								values: { total: "4", active: "1", failed: "1" },
								lines: ["a1b2c3d4 running Repository exploration", "e5f6a7b8 failed Repository verification"],
							},
						],
						[
							"bengacoon-quota",
							{
								values: {
									usage: JSON.stringify({
										plan: "pro",
										limits: [
											{
												name: "codex",
												limitReached: false,
												windows: [
													{
														label: "5h",
														usedPercent: 40,
														remainingPercent: 60,
														resetAt: 1_788_620_161_000,
													},
												],
											},
										],
									}),
								},
							},
						],
					]),
			},
		);

		expect(snapshot).toEqual({
			branch: "feat/sidebar",
			usage: { inputTokens: 1200, outputTokens: 300, cost: 0.42 },
			context: { remainingTokens: 750, remainingPercent: 75 },
			jobs: {
				total: 4,
				active: 1,
				failed: 1,
				details: ["a1b2c3d4 running Repository exploration", "e5f6a7b8 failed Repository verification"],
			},
			changes: { total: 0, added: 0, removed: 0, details: [] },
			delivery: null,
			quota: {
				plan: "pro",
				limits: [
					{
						name: "codex",
						limitReached: false,
						windows: [{ label: "5h", usedPercent: 40, remainingPercent: 60, resetAt: 1_788_620_161_000 }],
					},
				],
			},
		});
	});

	it("includes reported delivery progress and its receipt state", () => {
		const snapshot = createBengacoonStatusSnapshot(
			{
				getSessionStats: () => ({
					sessionFile: undefined,
					sessionId: "session-1",
					userMessages: 0,
					assistantMessages: 0,
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					contextUsage: { tokens: null, contextWindow: 1000, percent: null },
				}),
			},
			{
				getGitBranch: () => null,
				getExtensionStatusMetadata: () =>
					new Map([
						[
							"bengacoon-delivery",
							{
								values: {
									delivery: JSON.stringify({
										title: "Delivery observability",
										criterion: "The sidebar shows the active work item.",
										verification: "prove-red proven",
										receipt: "matches",
										nextStep: "Commit the delivery unit.",
									}),
								},
							},
						],
					]),
			},
		);

		expect(snapshot).toMatchObject({
			delivery: {
				title: "Delivery observability",
				verification: "prove-red proven",
				receipt: "matches",
			},
		});
	});

	it("marks unknown context and quota as unavailable", () => {
		const snapshot = createBengacoonStatusSnapshot(
			{
				getSessionStats: () => ({
					sessionFile: undefined,
					sessionId: "session-1",
					userMessages: 0,
					assistantMessages: 0,
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					contextUsage: { tokens: null, contextWindow: 1000, percent: null },
				}),
			},
			{
				getGitBranch: () => null,
				getExtensionStatusMetadata: () => new Map(),
			},
		);

		expect(snapshot.context).toEqual({ remainingTokens: null, remainingPercent: null });
		expect(snapshot.quota).toEqual({ plan: null, limits: [] });
	});
});
