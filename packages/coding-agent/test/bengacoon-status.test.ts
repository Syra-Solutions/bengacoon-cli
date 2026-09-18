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
						["bengacoon-quota", { values: { dailyRemainingPercent: "60", weeklyRemainingPercent: "20" } }],
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
			quota: { dailyRemainingPercent: 60, weeklyRemainingPercent: 20 },
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
		expect(snapshot.quota).toEqual({ dailyRemainingPercent: null, weeklyRemainingPercent: null });
	});
});
