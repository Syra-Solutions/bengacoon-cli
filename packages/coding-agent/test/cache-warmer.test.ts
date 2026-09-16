import type { CacheWarmPlan, CacheWarmResult } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer } from "../src/core/cache-warmer.ts";

const result: CacheWarmResult = {
	provider: "anthropic",
	model: "claude-test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 100,
		cacheWrite: 0,
		totalTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
	},
};

afterEach(() => vi.useRealTimers());

describe("CacheWarmer", () => {
	it("warms on the configured cadence until the maximum duration", async () => {
		vi.useFakeTimers();
		const record = vi.fn();
		const warm = vi.fn(async () => result);
		const plan: CacheWarmPlan = { ttlMs: 300_000, warm };
		const warmer = new CacheWarmer(record);

		warmer.start(plan, { mode: "idle", refreshAfterMs: 100, maxDurationMs: 250 });
		await vi.advanceTimersByTimeAsync(300);

		expect(warm).toHaveBeenCalledTimes(2);
		expect(record).toHaveBeenCalledTimes(2);
	});

	it("stops streaming mode on idle but keeps idle mode active", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => result);
		const warmer = new CacheWarmer(() => {});

		warmer.start({ ttlMs: 300_000, warm }, { mode: "streaming", refreshAfterMs: 100, maxDurationMs: 500 });
		warmer.onIdle();
		await vi.advanceTimersByTimeAsync(100);
		expect(warm).not.toHaveBeenCalled();

		warmer.start({ ttlMs: 300_000, warm }, { mode: "idle", refreshAfterMs: 100, maxDurationMs: 500 });
		warmer.onIdle();
		await vi.advanceTimersByTimeAsync(100);
		expect(warm).toHaveBeenCalledOnce();
	});
});
