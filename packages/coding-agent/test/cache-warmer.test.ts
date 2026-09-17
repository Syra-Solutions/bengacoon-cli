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
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecisionEvent,
	type CacheWarmingNotice,
	type CacheWarmRequest,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
} from "../src/core/cache-warmer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const adaptiveModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...getBuiltinModel("openai", "gpt-5"),
	promptCache: { short: 300, long: 86_400 },
};
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

/** A branch ending in an assistant response whose prompt had `promptTokens` tokens. */
function branchWithPrompt(promptTokens: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const assistant: AssistantMessage = {
		...response(adaptiveModel),
		usage: {
			input: 0,
			output: 10,
			cacheRead: promptTokens,
			cacheWrite: 0,
			totalTokens: promptTokens + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	entries.push({
		type: "message",
		id: "a",
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date(0).toISOString(),
		message: assistant,
	});
	return entries;
}

/** Fake runtime and session manager. `result` produces the response of each warm request. */
function fakeRuntime(
	options: {
		result?: (model: Model<Api>) => Promise<AssistantMessage>;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction;
		mode?: CacheWarmingMode;
		branch?: SessionEntry[];
		hasDecisionHandler?: boolean;
	} = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const appendUsage = vi.fn();
	const state = { mode: options.mode ?? "idle", branch: options.branch ?? branchWithPrompt(100_000) };
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				const result = options.result ?? (async (m: Model<Api>) => response(m));
				return { result: () => result(model) } as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => state.branch },
		() => state.mode,
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
		() => options.hasDecisionHandler ?? false,
	);
	return { warmer, calls, events, appendUsage, state };
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

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

describe("getCacheWarmingDelayMs", () => {
	it("uses 90% of the TTL while preserving at least ten seconds", () => {
		expect(getCacheWarmingDelayMs(300_000)).toBe(270_000);
		expect(getCacheWarmingDelayMs(60_000)).toBe(50_000);
		expect(getCacheWarmingDelayMs(10_000)).toBeUndefined();
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
	it("replays the request with a one-token cap at 90% of the TTL and records usage", async () => {
		vi.useFakeTimers();
		const { warmer, calls, appendUsage } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s", transformHeaders }), current);
		await vi.advanceTimersByTimeAsync(270_000);

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
			undefined,
		);

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
	});

	it("restores timing and accumulated cost from persisted warming usage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(280_000);
		// Idle refreshes only clear the savings reserve on a large prefix at a 15% continuation estimate.
		const branch = branchWithPrompt(400_000);
		branch.push({
			type: "usage",
			id: "w",
			parentId: "a",
			timestamp: new Date(20_000).toISOString(),
			kind: "cache_warm",
			provider: adaptiveModel.provider,
			model: adaptiveModel.id,
			usage: response(adaptiveModel).usage,
		});
		const { warmer, calls } = fakeRuntime({ branch });

		warmer.start(request(), current, { lastActivityAt: 20_000, startedAt: 0 });
		expect(warmer.status).toMatchObject({
			state: "scheduled",
			nextWarmAt: 290_000,
			evaluation: { phase: "idle", spentCost: 0.01, continuationProbability: 0.15 },
		});

		await vi.advanceTimersByTimeAsync(9_999);
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(1);
	});

	it("prices the decision from the last real request without exposing prompt contents", async () => {
		vi.useFakeTimers();
		const { warmer, events } = fakeRuntime({ decide: () => "stop" });

		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event).toMatchObject({
			type: "cache_warming_decision",
			mode: "idle",
			phase: "streaming",
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			ttlMs: 300_000,
			promptTokens: 100_000,
			spentCost: 0,
			continuationProbability: 1,
			action: "warm",
		});
		// 100k tokens on Opus: cache read $0.05, cache write $0.625, one output token $0.000025.
		expect(event.missCost).toBeCloseTo(0.575);
		expect(event.warmCost).toBeCloseTo(0.050025);
		expect(event).not.toHaveProperty("context");
	});

	it("stops when a refresh cannot clear the savings reserve", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events } = fakeRuntime({ branch: branchWithPrompt(5_000) });

		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(events[0].missCost - events[0].warmCost).toBeLessThan(CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS);
		expect(events[0].action).toBe("stop");
		expect(calls).toHaveLength(0);
		expect(warmer.status.state).toBe("stopped");
	});

	it("lets the decision handler override pi's action and reports the override", async () => {
		vi.useFakeTimers();
		const notices: CacheWarmingNotice[] = [];
		const { warmer, calls } = fakeRuntime({
			branch: branchWithPrompt(5_000),
			decide: () => "warm",
			hasDecisionHandler: true,
		});
		warmer.onChange = (notice) => {
			if (notice) notices.push(notice);
		};

		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(1);
		expect(notices).toEqual([{ usage: response(adaptiveModel).usage, note: "extension override" }]);
	});

	it("stops silently when cache economics are unavailable", async () => {
		vi.useFakeTimers();
		const notices: CacheWarmingNotice[] = [];
		const { warmer } = fakeRuntime({ branch: branchWithPrompt(0) });
		warmer.onChange = (notice) => {
			if (notice) notices.push(notice);
		};

		warmer.start(request(), current);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache economics unavailable" });
		await vi.advanceTimersByTimeAsync(270_000);
		expect(notices).toEqual([]);
	});

	it("does nothing when warming is off, the TTL is unknown, or the request cannot be replayed", async () => {
		vi.useFakeTimers();
		const { warmer, calls, state } = fakeRuntime();

		state.mode = "off";
		warmer.start(request(), current);
		state.mode = "idle";
		warmer.start(request(unknownModel), current);
		warmer.start(request(budgetModel, { reasoning: "high" }), current);
		await vi.advanceTimersByTimeAsync(600_000);

		expect(calls).toHaveLength(0);
		expect(warmer.status.state).toBe("inactive");
	});

	it("stops at the next tick when the context changed or warming was turned off", async () => {
		vi.useFakeTimers();
		const { warmer, calls, state } = fakeRuntime();

		let stillCurrent = true;
		warmer.start(request(), () => stillCurrent);
		expect(warmer.status.state).toBe("scheduled");
		stillCurrent = false;
		expect(warmer.status.state).toBe("inactive");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(0);

		warmer.start(request(), current);
		state.mode = "off";
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(0);
		expect(warmer.status.state).toBe("inactive");
	});

	it("uses separate one-hour streaming and 30-minute idle safety caps", async () => {
		vi.useFakeTimers();
		const { warmer, calls } = fakeRuntime({ branch: branchWithPrompt(400_000) });

		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(1);
		expect(warmer.status.state).toBe("inactive");

		warmer.start(request(), current);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(1_800_000);
		expect(calls).toHaveLength(7);
		expect(warmer.status.state).toBe("inactive");
	});

	it("does not record failed or aborted warm requests", async () => {
		vi.useFakeTimers();
		const { warmer, appendUsage } = fakeRuntime({ result: async (model) => response(model, "error") });

		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(appendUsage).not.toHaveBeenCalled();
		expect(warmer.status.state).toBe("scheduled");
	});

	it("includes accumulated warming cost in later decisions", async () => {
		vi.useFakeTimers();
		const { warmer, events } = fakeRuntime();

		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(540_000);

		expect(events.map((event) => event.spentCost)).toEqual([0, 0.01]);
	});

	it("replaces the previous run and aborts its in-flight warm request", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const { warmer, calls } = fakeRuntime({
			result: (model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		});

		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(1);

		warmer.start(request(), current);
		expect(calls[0].options?.signal?.aborted).toBe(true);
		release();
		warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(1);
	});

	it("stops on agent settled in streaming mode and lowers the odds in idle mode", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, state } = fakeRuntime({ mode: "streaming", branch: branchWithPrompt(400_000) });

		warmer.start(request(), current);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(540_000);
		expect(calls).toHaveLength(0);

		state.mode = "idle";
		warmer.start(request(), current);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(540_000);
		expect(calls).toHaveLength(2);
		expect(events.map((event) => [event.phase, event.continuationProbability])).toEqual([
			["idle", 0.15],
			["idle", 0.15],
		]);
	});

	it("stops idle warming when the continuation estimate cannot pay for the refresh", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events } = fakeRuntime({ branch: branchWithPrompt(100_000) });

		warmer.start(request(), current);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(270_000);

		expect(events[0]).toMatchObject({ phase: "idle", continuationProbability: 0.15, action: "stop" });
		expect(calls).toHaveLength(0);
		expect(warmer.status.state).toBe("stopped");
	});

	it("reports schedule changes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const seen: Array<number | undefined> = [];
		const { warmer } = fakeRuntime();
		warmer.onChange = () => seen.push(warmer.status.nextWarmAt);

		warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		warmer.cancel();
		expect(seen).toEqual([270_000, 540_000, undefined]);
	});
});

describe("ExtensionRunner.emitCacheWarmingDecision", () => {
	it("returns pi's action unless a handler overrides it, last override wins", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const seen: CacheWarmingAction[] = [];
		const factories: ExtensionFactory[] = [
			(pi) =>
				pi.on("cache_warming_decision", (event) => {
					seen.push(event.action);
					return { action: "warm" };
				}),
			(pi) => pi.on("cache_warming_decision", () => ({ action: "stop" })),
			(pi) => pi.on("cache_warming_decision", () => undefined),
		];
		const extensions = [];
		for (const factory of factories) {
			extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const event: CacheWarmingDecisionEvent = {
			type: "cache_warming_decision",
			mode: "idle",
			phase: "idle",
			model: { provider: "test", id: "model" },
			ttlMs: 300_000,
			promptTokens: 100_000,
			warmCost: 0.05,
			missCost: 0.5,
			spentCost: 0,
			continuationProbability: 0.15,
			action: "warm",
		};

		const empty = new ExtensionRunner([], runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		expect(await empty.emitCacheWarmingDecision(event)).toBe("warm");

		const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
		expect(seen).toEqual(["warm"]);
	});
});
