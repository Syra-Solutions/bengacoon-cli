import type { CacheWarmPlan, CacheWarmResult } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer } from "../src/core/cache-warmer.ts";

const result: CacheWarmResult = {
	provider: "custom-provider",
	model: "custom-model",
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
		expect(warmer.getState()).toEqual({ status: "inactive" });
	});

	it("derives the default cadence from the provider cache TTL", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => result);
		const warmer = new CacheWarmer(() => {});

		warmer.start({ ttlMs: 100, warm }, { mode: "idle", maxDurationMs: 250 });
		await vi.advanceTimersByTimeAsync(250);

		expect(warm).toHaveBeenCalledTimes(3);
	});

	it("caps an explicit cadence at 95% of the provider cache TTL", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => result);
		const warmer = new CacheWarmer(() => {});

		warmer.start({ ttlMs: 100, warm }, { mode: "idle", refreshAfterMs: 500, maxDurationMs: 200 });
		await vi.advanceTimersByTimeAsync(200);

		expect(warm).toHaveBeenCalledTimes(2);
	});

	it("reports scheduled and in-flight warming state", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		let finishWarm!: (value: CacheWarmResult) => void;
		const warm = vi.fn(
			() =>
				new Promise<CacheWarmResult>((resolve) => {
					finishWarm = resolve;
				}),
		);
		const warmer = new CacheWarmer(() => {});
		const states: string[] = [];
		warmer.subscribe((state) => states.push(state.status));

		warmer.start({ ttlMs: 300_000, warm }, { mode: "idle", refreshAfterMs: 100, maxDurationMs: 500 });
		expect(warmer.getState()).toEqual({ status: "scheduled", mode: "idle", nextWarmAt: 1_100 });

		vi.advanceTimersByTime(100);
		expect(warmer.getState()).toEqual({ status: "warming", mode: "idle", startedAt: 1_100 });

		finishWarm(result);
		await Promise.resolve();
		expect(warmer.getState()).toEqual({ status: "scheduled", mode: "idle", nextWarmAt: 1_200 });
		warmer.cancel();

		expect(warmer.getState()).toEqual({ status: "inactive" });
		expect(states).toEqual(["scheduled", "warming", "scheduled", "inactive"]);
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
