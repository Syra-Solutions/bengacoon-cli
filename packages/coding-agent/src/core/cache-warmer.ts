import {
	type Api,
	type Context,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionManager } from "./session-manager.ts";
import type { CacheWarmingMode, CacheWarmingSettings } from "./settings-manager.ts";

export const CACHE_WARMING_MODES: readonly CacheWarmingMode[] = ["off", "streaming", "idle", "auto"];

const MAX_WARMING_AGE_MS = 60 * 60_000;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention =
		options?.cacheRetention ??
		(getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Anthropic's budget-based thinking (Claude models without
 * adaptive thinking) derives `budget_tokens` from `max_tokens`; the replay
 * would get a different budget, which Anthropic keys the message cache on,
 * and the model could still think for thousands of tokens.
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning || model.api !== "anthropic-messages") return true;
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

export type ActiveCacheWarmingMode = Exclude<CacheWarmingMode, "off">;
export type CacheWarmingPhase = "streaming" | "idle";
export type CacheWarmingAction = "warm" | "stop";

export interface CacheWarmingCosts {
	/** Estimated price of serving the prompt from cache. */
	cacheHit: number;
	/** Estimated price of serving the prompt without a cache hit. */
	cacheMiss: number;
	/** Additional price caused by a cache miss. */
	missPenalty: number;
	/** Estimated price of the next one-token warming request. */
	nextWarm: number;
}

/**
 * Fired before a scheduled cache refresh. Prompt contents are deliberately not
 * exposed. The bundled policy fills in the probability and default decision
 * before user extensions run.
 */
export interface CacheWarmingDecisionEvent {
	type: "cache_warming_decision";
	profile: ActiveCacheWarmingMode;
	phase: CacheWarmingPhase;
	model: { provider: string; id: string };
	ttlMs: number;
	promptTokens: number;
	costs: CacheWarmingCosts;
	cumulativeWarmCost: number;
	continuationProbability: number;
	expectedSavings: number;
	minimumExpectedSavings: number;
	defaultAction: CacheWarmingAction;
}

export interface CacheWarmingDecisionEventResult {
	/** Override whether this candidate refresh is sent. */
	action?: CacheWarmingAction;
	/** Optional metadata describing a custom probability estimate. */
	continuationProbability?: number;
	/** Optional metadata describing custom expected savings. */
	expectedSavings?: number;
	/** Optional metadata describing the reserve used by a custom policy. */
	minimumExpectedSavings?: number;
}

export type CacheWarmingDecisionHandler = (
	event: CacheWarmingDecisionEvent,
) => Promise<CacheWarmingAction> | CacheWarmingAction;

export type CacheWarmingState =
	| { status: "inactive" }
	| {
			status: "scheduled";
			mode: ActiveCacheWarmingMode;
			scheduledAt: number;
			nextWarmAt: number;
			/** When the previous refresh of this run was sent, if any. */
			warmedAt?: number;
	  }
	| { status: "warming"; mode: ActiveCacheWarmingMode; startedAt: number };

export type CacheWarmingStateListener = (state: CacheWarmingState) => void;

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

interface ActiveRun {
	controller: AbortController;
	cumulativeWarmCost: number;
	deadline: number;
	mode: ActiveCacheWarmingMode;
	phase: CacheWarmingPhase;
	promptTokens: number;
	timer?: ReturnType<typeof setTimeout>;
}

function getCostRates(model: Model<Api>, inputTokens: number): Model<Api>["cost"] {
	let rates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}
	return rates;
}

function estimateCosts(model: Model<Api>, promptTokens: number): CacheWarmingCosts {
	const rates = getCostRates(model, promptTokens);
	const cacheHit = (rates.cacheRead * promptTokens) / 1_000_000;
	const cacheMissRate = rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
	const cacheMiss = (cacheMissRate * promptTokens) / 1_000_000;
	return {
		cacheHit,
		cacheMiss,
		missPenalty: Math.max(0, cacheMiss - cacheHit),
		nextWarm: cacheHit + rates.output / 1_000_000,
	};
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. Policy is delegated to the
 * `cache_warming_decision` extension event. `start` replaces any previous run;
 * warm requests never extend the fixed one-hour safety window.
 */
export class CacheWarmer {
	private active?: ActiveRun;
	private state: CacheWarmingState = { status: "inactive" };
	private readonly listeners = new Set<CacheWarmingStateListener>();
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage">;
	private readonly decide: CacheWarmingDecisionHandler;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage">,
		decide: CacheWarmingDecisionHandler = () => "stop",
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.decide = decide;
	}

	getState(): CacheWarmingState {
		return this.state;
	}

	subscribe(listener: CacheWarmingStateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	cancel(): void {
		const active = this.active;
		this.active = undefined;
		this.setState({ status: "inactive" });
		if (!active) return;
		if (active.timer) clearTimeout(active.timer);
		active.controller.abort();
	}

	onAgentSettled(): void {
		if (!this.active) return;
		if (this.active.mode === "streaming") {
			this.cancel();
			return;
		}
		this.active.phase = "idle";
	}

	/** Record provider-reported prompt usage for the current real request. */
	recordRequestUsage(usage: Usage): void {
		if (!this.active) return;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens > 0) this.active.promptTokens = promptTokens;
	}

	/**
	 * Keep the prompt cache entry written by `request` warm. Cancels any
	 * previous run first, so calling this for every session request also stops
	 * warming a superseded context. Does nothing further when warming is off or
	 * the model's cache lifetime is unknown.
	 */
	start(request: CacheWarmRequest, settings: Required<CacheWarmingSettings>): void {
		this.cancel();
		if (settings.mode === "off" || !isReplayable(request.model, request.options)) return;
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		const refreshAfterMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
		if (ttlMs === undefined || refreshAfterMs === undefined) return;

		const active: ActiveRun = {
			controller: new AbortController(),
			cumulativeWarmCost: 0,
			deadline: Date.now() + MAX_WARMING_AGE_MS,
			mode: settings.mode,
			phase: "streaming",
			promptTokens: estimateContextTokens(normalizeContext(request.context)).tokens,
		};
		this.active = active;
		let warmedAt: number | undefined;

		const schedule = (): void => {
			if (this.active !== active) return;
			const scheduledAt = Date.now();
			const nextWarmAt = scheduledAt + refreshAfterMs;
			if (nextWarmAt > active.deadline) {
				this.active = undefined;
				this.setState({ status: "inactive" });
				return;
			}
			this.setState({ status: "scheduled", mode: active.mode, scheduledAt, nextWarmAt, warmedAt });
			active.timer = setTimeout(async () => {
				active.timer = undefined;
				const costs = estimateCosts(request.model, active.promptTokens);
				const event: CacheWarmingDecisionEvent = {
					type: "cache_warming_decision",
					profile: active.mode,
					phase: active.phase,
					model: { provider: request.model.provider, id: request.model.id },
					ttlMs,
					promptTokens: active.promptTokens,
					costs,
					cumulativeWarmCost: active.cumulativeWarmCost,
					continuationProbability: 0,
					expectedSavings: -costs.nextWarm - active.cumulativeWarmCost,
					minimumExpectedSavings: 0,
					defaultAction: "stop",
				};
				let action: CacheWarmingAction = "stop";
				try {
					action = await this.decide(event);
				} catch {
					// Cache warming is best-effort and extension failures default to stopping.
				}
				if (this.active !== active) return;
				if (action === "stop") {
					this.active = undefined;
					this.setState({ status: "inactive" });
					return;
				}

				const startedAt = Date.now();
				this.setState({ status: "warming", mode: active.mode, startedAt });
				try {
					const message = await this.models
						.streamSimple(request.model, request.context, {
							...request.options,
							maxTokens: 1,
							maxRetries: 0,
							signal: active.controller.signal,
						})
						.result();
					if (message.stopReason !== "error" && message.stopReason !== "aborted") {
						active.cumulativeWarmCost += message.usage.cost.total;
						this.sessionManager.appendUsage(
							"cache_warm",
							message.provider,
							message.responseModel ?? message.model,
							message.usage,
						);
					}
				} catch {
					// Cache warming is best-effort and must not affect the active agent run.
				} finally {
					warmedAt = startedAt;
					schedule();
				}
			}, refreshAfterMs);
			active.timer.unref?.();
		};
		schedule();
	}

	private setState(state: CacheWarmingState): void {
		if (state.status === "inactive" && this.state.status === "inactive") return;
		this.state = state;
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch {
				// Observers must not affect best-effort cache warming.
			}
		}
	}
}
