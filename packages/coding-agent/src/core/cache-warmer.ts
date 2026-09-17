import {
	type Api,
	type Context,
	calculateCost,
	type Model,
	type ModelsSimpleStreamOptions,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

/** Streaming warming never continues past this long after the real request that started it. */
const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from our own usage; per-session estimates were not
 * better than this constant.
 */
export const IDLE_CONTINUATION_PROBABILITY = 0.15;

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

/** Prompt size of the most recent real request on the branch, as reported by the provider. */
function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

export type CacheWarmingAction = "warm" | "stop";

/**
 * Fired before each scheduled cache refresh with pi's decision filled in.
 * Prompt contents are deliberately not exposed.
 */
export interface CacheWarmingDecisionEvent {
	type: "cache_warming_decision";
	mode: Exclude<CacheWarmingMode, "off">;
	/** "streaming" while the agent run that sent the request is still active. */
	phase: "streaming" | "idle";
	model: { provider: string; id: string };
	ttlMs: number;
	promptTokens: number;
	/** Price of this refresh: a cache read of the prompt plus one output token. */
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost. */
	missCost: number;
	/** Price of the refreshes already sent for this entry. */
	spentCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	continuationProbability: number;
	/** Pi's decision: warm when `continuationProbability * missCost - spentCost - warmCost` is at least $0.05. */
	action: CacheWarmingAction;
}

export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	action?: CacheWarmingAction;
}

export interface CacheWarmingEvaluation extends CacheWarmingDecisionEvent {
	expectedSavings: number;
	economicsAvailable: boolean;
}

export interface CacheWarmingStatus {
	state: "inactive" | "scheduled" | "refreshing" | "stopped";
	reason?: string;
	nextWarmAt?: number;
	evaluation?: CacheWarmingEvaluation;
	extensionPolicy: boolean;
	extensionOverride: boolean;
	indicator: boolean;
}

export type CacheWarmingNotice = Pick<UsageEntry, "usage" | "note">;

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

interface ActiveRun {
	request: CacheWarmRequest;
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
	ttlMs: number;
	delayMs: number;
	deadline: number;
	idleDeadline: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	spentCost: number;
	nextWarmAt: number;
	decision?: { evaluation: CacheWarmingEvaluation; extensionOverride: boolean };
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactiveReason: string;
	private stopped?: { evaluation: CacheWarmingEvaluation; extensionOverride: boolean };
	private warmedUntil = 0;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	private readonly hasDecisionHandler: () => boolean;
	/** Called when status changes. A notice is present only after successful warming usage. */
	onChange?: (notice?: CacheWarmingNotice) => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
		hasDecisionHandler: () => boolean = () => false,
		initialInactiveReason = "waiting for first request",
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.hasDecisionHandler = hasDecisionHandler;
		this.inactiveReason = initialInactiveReason;
	}

	get status(): CacheWarmingStatus {
		const extensionPolicy = this.hasDecisionHandler();
		const mode = this.getMode();
		if (mode === "off") {
			return {
				state: "inactive",
				reason: "cache warming disabled",
				extensionPolicy,
				extensionOverride: false,
				indicator: false,
			};
		}

		const run = this.run;
		if (!run) {
			if (this.stopped) {
				return {
					state: "stopped",
					evaluation: this.stopped.evaluation,
					extensionPolicy,
					extensionOverride: this.stopped.extensionOverride,
					indicator: Date.now() < this.warmedUntil,
				};
			}
			return {
				state: "inactive",
				reason: this.inactiveReason,
				extensionPolicy,
				extensionOverride: false,
				indicator: Date.now() < this.warmedUntil,
			};
		}
		if (!run.isCurrent()) {
			return {
				state: "inactive",
				reason: "conversation context changed",
				extensionPolicy,
				extensionOverride: false,
				indicator: false,
			};
		}

		const evaluation = run.decision?.evaluation ?? this.evaluate(run, mode);
		if (!evaluation.economicsAvailable && !extensionPolicy && !run.decision) {
			return {
				state: "inactive",
				reason: "cache economics unavailable",
				extensionPolicy,
				extensionOverride: false,
				indicator: Date.now() < this.warmedUntil,
			};
		}
		return {
			state: run.timer ? "scheduled" : "refreshing",
			nextWarmAt: run.nextWarmAt,
			evaluation,
			extensionPolicy,
			extensionOverride: run.decision?.extensionOverride ?? false,
			indicator: Date.now() < this.warmedUntil || run.decision !== undefined || evaluation.action === "warm",
		};
	}

	/** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
	start(
		request: CacheWarmRequest,
		isCurrent: () => boolean,
		restored?: { lastActivityAt: number; startedAt: number },
	): void {
		this.clearRun();
		this.stopped = undefined;
		this.warmedUntil = 0;
		const mode = this.getMode();
		if (mode === "off") {
			this.inactiveReason = "cache warming disabled";
			this.onChange?.();
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.inactiveReason = "request cannot be replayed safely";
			this.onChange?.();
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
		if (ttlMs === undefined || delayMs === undefined) {
			this.inactiveReason =
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable";
			this.onChange?.();
			return;
		}
		if (restored && restored.lastActivityAt + ttlMs <= Date.now()) {
			this.inactiveReason = "cache expired before startup";
			this.onChange?.();
			return;
		}
		if (restored) this.warmedUntil = restored.lastActivityAt + ttlMs;
		if (restored && mode === "streaming") {
			this.inactiveReason = "streaming run ended before restart";
			this.onChange?.();
			return;
		}
		let spentCost = 0;
		if (restored) {
			for (const entry of this.sessionManager.getBranch()) {
				if (
					entry.type === "usage" &&
					entry.kind === "cache_warm" &&
					entry.provider === request.model.provider &&
					Date.parse(entry.timestamp) >= restored.startedAt
				) {
					spentCost += entry.usage.cost.total;
				}
			}
		}
		const startedAt = restored?.startedAt ?? Date.now();
		this.run = {
			request,
			isCurrent,
			ttlMs,
			delayMs,
			deadline: startedAt + MAX_WARMING_AGE_MS,
			idleDeadline: startedAt + MAX_IDLE_WARMING_AGE_MS,
			controller: new AbortController(),
			phase: restored ? "idle" : "streaming",
			spentCost,
			nextWarmAt: 0,
		};
		this.schedule(this.run, undefined, restored?.lastActivityAt);
	}

	onAgentSettled(): void {
		if (!this.run) return;
		if (this.getMode() === "streaming") {
			this.stop("agent run settled");
		} else {
			this.run.phase = "idle";
			if (this.run.nextWarmAt > this.run.idleDeadline || Date.now() >= this.run.idleDeadline) {
				this.stop("30-minute idle safety limit reached");
				return;
			}
			this.onChange?.();
		}
	}

	cancel(): void {
		this.clearRun();
		this.stopped = undefined;
		this.warmedUntil = 0;
		this.inactiveReason = "inactive";
		this.onChange?.();
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private stop(reason: string, notice?: CacheWarmingNotice): void {
		this.clearRun();
		this.stopped = undefined;
		this.inactiveReason = reason;
		this.onChange?.(notice);
	}

	private schedule(run: ActiveRun, notice?: CacheWarmingNotice, lastActivityAt = Date.now()): void {
		run.decision = undefined;
		run.nextWarmAt = lastActivityAt + run.delayMs;
		const deadline = run.phase === "idle" ? run.idleDeadline : run.deadline;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(
				run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached",
				notice,
			);
			return;
		}
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
		this.onChange?.(notice);
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		const mode = this.getMode();
		if (mode === "off" || !run.isCurrent()) {
			this.stop(mode === "off" ? "cache warming disabled" : "conversation context changed");
			return;
		}
		const evaluation = this.evaluate(run, mode);
		let action = evaluation.action;
		try {
			action = await this.decide(evaluation);
		} catch {
			// Extension failures fall back to pi's own decision.
		}
		if (this.run !== run) return;
		const extensionOverride = action !== evaluation.action;
		if (action === "stop") {
			if (!evaluation.economicsAvailable && !extensionOverride) {
				this.stop("cache economics unavailable");
				return;
			}
			this.clearRun();
			this.stopped = { evaluation, extensionOverride };
			this.onChange?.();
			return;
		}

		run.decision = { evaluation, extensionOverride };
		let notice: CacheWarmingNotice | undefined;
		try {
			const message = await this.models
				.streamSimple(run.request.model, run.request.context, {
					...run.request.options,
					maxTokens: 1,
					maxRetries: 0,
					signal: run.controller.signal,
				})
				.result();
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				run.spentCost += message.usage.cost.total;
				this.warmedUntil = Date.now() + run.ttlMs;
				const note = extensionOverride ? "extension override" : undefined;
				this.sessionManager.appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					note,
				);
				notice = { usage: message.usage, ...(note ? { note } : {}) };
			}
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		if (this.run === run) this.schedule(run, notice);
	}

	private evaluate(run: ActiveRun, mode: Exclude<CacheWarmingMode, "off">): CacheWarmingEvaluation {
		const model = run.request.model;
		const branch = this.sessionManager.getBranch();
		const promptTokens = lastPromptTokens(branch);
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		const cacheMissCost = price(
			model,
			model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens },
		);
		const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		const expectedSavings = continuationProbability * missCost - run.spentCost - warmCost;
		return {
			type: "cache_warming_decision",
			mode,
			phase: run.phase,
			model: { provider: model.provider, id: model.id },
			ttlMs: run.ttlMs,
			promptTokens,
			warmCost,
			missCost,
			spentCost: run.spentCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: economicsAvailable && expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}
