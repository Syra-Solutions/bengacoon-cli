import type { CacheWarmPlan, CacheWarmResult } from "@earendil-works/pi-ai";
import type { ResolvedCacheWarmingSettings } from "./model-config.ts";

export class CacheWarmer {
	private generation = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private abortController?: AbortController;
	private cancelWhenIdle = false;
	private readonly record: (result: CacheWarmResult) => void;

	constructor(record: (result: CacheWarmResult) => void) {
		this.record = record;
	}

	cancel(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.abortController?.abort();
		this.abortController = undefined;
		this.cancelWhenIdle = false;
	}

	onIdle(): void {
		if (this.cancelWhenIdle) this.cancel();
	}

	start(plan: CacheWarmPlan, settings: ResolvedCacheWarmingSettings): void {
		this.cancel();
		this.cancelWhenIdle = settings.mode === "streaming";
		const generation = this.generation;
		const deadline = Date.now() + settings.maxDurationMs;

		const schedule = () => {
			if (generation !== this.generation || Date.now() + settings.refreshAfterMs > deadline) return;
			this.timer = setTimeout(async () => {
				this.timer = undefined;
				const controller = new AbortController();
				this.abortController = controller;
				try {
					const result = await plan.warm(controller.signal);
					this.record(result);
				} catch {
					// Cache warming is best-effort and must not affect the active agent run.
				} finally {
					if (this.abortController === controller) this.abortController = undefined;
					if (generation === this.generation) schedule();
				}
			}, settings.refreshAfterMs);
			this.timer.unref?.();
		};
		schedule();
	}
}
