import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CacheWarmer,
	type CacheWarmingState,
	type CacheWarmRequest,
	formatCacheWarmingMaxMinutes,
	getPromptCacheTtlMs,
	isReplayable,
} from "../src/core/cache-warmer.ts";

const adaptiveModel: Model<Api> = getBuiltinModel("anthropic", "claude-opus-4-6");
const budgetModel: Model<Api> = getBuiltinModel("anthropic", "claude-sonnet-4-5");
const openaiModel: Model<Api> = getBuiltinModel("openai", "gpt-5");
const unknownModel: Model<Api> = { ...adaptiveModel, promptCache: undefined };

function response(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 1,
			cacheRead: 100,
			cacheWrite: 0,
			totalTokens: 101,
			cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
		},
		stopReason,
		timestamp: 0,
	};
}

/** Fake runtime and session manager. `result` produces the response of each warm request. */
function fakeRuntime(result: (model: Model<Api>) => Promise<AssistantMessage> = async (model) => response(model)) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const appendUsage = vi.fn();
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, options) => {
				calls.push({ model, options });
				return { result: () => result(model) } as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage },
	);
	return { warmer, calls, appendUsage };
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const idle = { mode: "idle", maxMinutes: 60 } as const;

afterEach(() => vi.useRealTimers());

describe("getPromptCacheTtlMs", () => {
	it("reads the model's tier for the retention the request used", () => {
		expect(getPromptCacheTtlMs(adaptiveModel, undefined)).toBe(300_000);
		expect(getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" })).toBe(3_600_000);
		expect(getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" })).toBeUndefined();
		expect(getPromptCacheTtlMs(adaptiveModel, { env: { PI_CACHE_RETENTION: "long" } })).toBe(3_600_000);
		expect(getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" })).toBe(86_400_000);
		expect(getPromptCacheTtlMs(unknownModel, undefined)).toBeUndefined();
		expect(
			getPromptCacheTtlMs({ ...adaptiveModel, promptCache: { short: 60 } }, { cacheRetention: "long" }),
		).toBeUndefined();
	});
});

describe("isReplayable", () => {
	it("refuses Anthropic budget-based thinking only", () => {
		expect(isReplayable(budgetModel, { reasoning: "medium" })).toBe(false);
		expect(isReplayable(budgetModel, undefined)).toBe(true);
		expect(isReplayable(adaptiveModel, { reasoning: "medium" })).toBe(true);
		expect(isReplayable(openaiModel, { reasoning: "medium" })).toBe(true);
	});
});

describe("CacheWarmer", () => {
	it("replays the request with a one-token cap at 80% of the TTL and records usage", async () => {
		vi.useFakeTimers();
		const { warmer, calls, appendUsage } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s", transformHeaders }), idle);
		await vi.advanceTimersByTimeAsync(240_000);

		expect(calls).toHaveLength(1);
		expect(calls[0].model).toBe(adaptiveModel);
		expect(calls[0].options).toMatchObject({
			reasoning: "high",
			sessionId: "s",
			transformHeaders,
			maxTokens: 1,
			maxRetries: 0,
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			response(adaptiveModel).usage,
		);

		await vi.advanceTimersByTimeAsync(240_000);
		expect(calls).toHaveLength(2);
	});

	it("does nothing when warming is off, the TTL is unknown, or the request cannot be replayed", async () => {
		vi.useFakeTimers();
		const { warmer, calls } = fakeRuntime();

		warmer.start(request(), { mode: "off", maxMinutes: 60 });
		warmer.start(request(unknownModel), idle);
		warmer.start(request(budgetModel, { reasoning: "high" }), idle);
		await vi.advanceTimersByTimeAsync(600_000);

		expect(calls).toHaveLength(0);
		expect(warmer.getState()).toEqual({ status: "inactive" });
	});

	it("stops at the window and never warms when the cache outlives it", async () => {
		vi.useFakeTimers();
		const { warmer, calls } = fakeRuntime();

		warmer.start(request(), { mode: "idle", maxMinutes: 10 });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(2);
		expect(warmer.getState()).toEqual({ status: "inactive" });

		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), { mode: "idle", maxMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(2);
	});

	it("does not record failed or aborted warm requests", async () => {
		vi.useFakeTimers();
		const { warmer, appendUsage } = fakeRuntime(async (model) => response(model, "error"));

		warmer.start(request(), idle);
		await vi.advanceTimersByTimeAsync(240_000);

		expect(appendUsage).not.toHaveBeenCalled();
		expect(warmer.getState().status).toBe("scheduled");
	});

	it("replaces the previous run and aborts its in-flight warm request", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const { warmer, calls } = fakeRuntime(
			(model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		);

		warmer.start(request(), idle);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(calls).toHaveLength(1);
		expect(warmer.getState().status).toBe("warming");

		warmer.start(request(), idle);
		expect(calls[0].options?.signal?.aborted).toBe(true);
		release();
		warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(1);
	});

	it("stops on agent settled only in streaming mode", async () => {
		vi.useFakeTimers();
		const { warmer, calls } = fakeRuntime();

		warmer.start(request(), { mode: "streaming", maxMinutes: 60 });
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(480_000);
		expect(calls).toHaveLength(0);

		warmer.start(request(), idle);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(480_000);
		expect(calls).toHaveLength(2);
	});

	it("reports scheduled, warming, and inactive states to subscribers", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const states: CacheWarmingState[] = [];
		const { warmer } = fakeRuntime();
		warmer.subscribe((state) => states.push(state));

		warmer.start(request(), { mode: "idle", maxMinutes: 8 });
		expect(warmer.getState()).toEqual({ status: "scheduled", mode: "idle", scheduledAt: 0, nextWarmAt: 240_000 });
		await vi.advanceTimersByTimeAsync(480_000);
		expect(states.map((state) => state.status)).toEqual(["scheduled", "warming", "scheduled", "warming", "inactive"]);
		expect(states[1]).toEqual({ status: "warming", mode: "idle", startedAt: 240_000 });
		expect(states[2]).toEqual({
			status: "scheduled",
			mode: "idle",
			scheduledAt: 240_000,
			nextWarmAt: 480_000,
			warmedAt: 240_000,
		});
	});
});

describe("formatCacheWarmingMaxMinutes", () => {
	it("uses choice labels and falls back to minutes", () => {
		expect(formatCacheWarmingMaxMinutes(60)).toBe("60 min");
		expect(formatCacheWarmingMaxMinutes(45)).toBe("45 min");
	});
});
