import type { Api, Context, Model, ModelsSimpleStreamOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionManager } from "./session-manager.ts";
import type { CacheWarmingMode, CacheWarmingSettings } from "./settings-manager.ts";

export const CACHE_WARMING_MODES: readonly CacheWarmingMode[] = ["off", "streaming", "idle"];

export const CACHE_WARMING_MAX_MINUTES_CHOICES = [
	{ label: "30 min", minutes: 30 },
	{ label: "60 min", minutes: 60 },
	{ label: "120 min", minutes: 120 },
] as const;

/** Fraction of the cache lifetime to wait before refreshing it. */
const REFRESH_FRACTION = 0.8;

export function formatCacheWarmingMaxMinutes(minutes: number): string {
	return CACHE_WARMING_MAX_MINUTES_CHOICES.find((choice) => choice.minutes === minutes)?.label ?? `${minutes} min`;
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
	deadline: number;
	mode: ActiveCacheWarmingMode;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any previous
 * run and restarts the duration window; warm requests never extend it.
 */
export class CacheWarmer {
	private active?: ActiveRun;
	private state: CacheWarmingState = { status: "inactive" };
	private readonly listeners = new Set<CacheWarmingStateListener>();
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage">;

	constructor(models: Pick<ModelRuntime, "streamSimple">, sessionManager: Pick<SessionManager, "appendUsage">) {
		this.models = models;
		this.sessionManager = sessionManager;
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
		if (this.active?.mode === "streaming") this.cancel();
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
		if (ttlMs === undefined) return;

		const active: ActiveRun = {
			controller: new AbortController(),
			deadline: Date.now() + settings.maxMinutes * 60_000,
			mode: settings.mode,
		};
		this.active = active;
		const refreshAfterMs = Math.max(1, Math.floor(ttlMs * REFRESH_FRACTION));
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
