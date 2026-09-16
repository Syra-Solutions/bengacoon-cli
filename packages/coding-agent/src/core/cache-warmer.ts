import type { CacheWarmPlan, CacheWarmResult } from "@earendil-works/pi-ai";
import type { ResolvedCacheWarmingSettings } from "./model-config.ts";

export type CacheWarmingState =
	| { status: "inactive" }
	| { status: "scheduled"; mode: ResolvedCacheWarmingSettings["mode"]; nextWarmAt: number }
	| { status: "warming"; mode: ResolvedCacheWarmingSettings["mode"]; startedAt: number };

export type CacheWarmingStateListener = (state: CacheWarmingState) => void;

export class CacheWarmer {
	private generation = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private abortController?: AbortController;
	private cancelWhenIdle = false;
	private state: CacheWarmingState = { status: "inactive" };
	private readonly listeners = new Set<CacheWarmingStateListener>();
	private readonly record: (result: CacheWarmResult) => void;

	constructor(record: (result: CacheWarmResult) => void) {
		this.record = record;
	}

	getState(): CacheWarmingState {
		return this.state;
	}

	subscribe(listener: CacheWarmingStateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	cancel(): void {
		this.stopCurrentPlan();
		this.setState({ status: "inactive" });
	}

	onIdle(): void {
		if (this.cancelWhenIdle) this.cancel();
	}

	start(plan: CacheWarmPlan, settings: ResolvedCacheWarmingSettings): void {
		this.stopCurrentPlan();
		this.cancelWhenIdle = settings.mode === "streaming";
		const generation = this.generation;
		const deadline = Date.now() + settings.maxDurationMs;
		// Default conservatively to 80% of the provider TTL. Explicit cadences
		// may use up to 95%, preserving a small margin for timer and network jitter.
		const defaultRefreshAfterMs = Math.max(1, Math.floor(plan.ttlMs * 0.8));
		const maxRefreshAfterMs = Math.max(1, Math.floor(plan.ttlMs * 0.95));
		const refreshAfterMs = Math.min(settings.refreshAfterMs ?? defaultRefreshAfterMs, maxRefreshAfterMs);

		const schedule = () => {
			if (generation !== this.generation) return;
			const nextWarmAt = Date.now() + refreshAfterMs;
			if (nextWarmAt > deadline) {
				this.setState({ status: "inactive" });
				return;
			}
			this.setState({ status: "scheduled", mode: settings.mode, nextWarmAt });
			this.timer = setTimeout(async () => {
				this.timer = undefined;
				const controller = new AbortController();
				this.abortController = controller;
				this.setState({ status: "warming", mode: settings.mode, startedAt: Date.now() });
				try {
					const result = await plan.warm(controller.signal);
					this.record(result);
				} catch {
					// Cache warming is best-effort and must not affect the active agent run.
				} finally {
					if (this.abortController === controller) this.abortController = undefined;
					if (generation === this.generation) schedule();
				}
			}, refreshAfterMs);
			this.timer.unref?.();
		};
		schedule();
	}

	private stopCurrentPlan(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.abortController?.abort();
		this.abortController = undefined;
		this.cancelWhenIdle = false;
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
