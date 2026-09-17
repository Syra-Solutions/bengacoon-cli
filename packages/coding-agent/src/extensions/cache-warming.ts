import type {
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../core/session-manager.ts";

export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
const MIN_IDLE_PROBABILITY = 0.25;
const MAX_IDLE_PROBABILITY = 0.75;

function userMessageTimestamps(sessionManager: ReadonlySessionManager): number[] {
	const timestamps: number[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "user" && Number.isFinite(entry.message.timestamp)) {
			timestamps.push(entry.message.timestamp);
		}
	}
	return timestamps;
}

/** Estimate P(next user message arrives before this cache entry expires). */
export function getAutoContinuationProbability(
	sessionManager: ReadonlySessionManager,
	now: number,
	ttlMs: number,
): number {
	const timestamps = userMessageTimestamps(sessionManager);
	const latest = timestamps.at(-1);
	if (latest === undefined) return MIN_IDLE_PROBABILITY;

	const idleAgeMs = Math.max(0, now - latest);
	const eligibleGaps: number[] = [];
	for (let index = 1; index < timestamps.length; index++) {
		const gap = timestamps[index] - timestamps[index - 1];
		if (gap >= idleAgeMs) eligibleGaps.push(gap);
	}
	if (eligibleGaps.length === 0) return MIN_IDLE_PROBABILITY;

	const resumedWithinTtl = eligibleGaps.filter((gap) => gap <= idleAgeMs + ttlMs).length;
	return Math.min(MAX_IDLE_PROBABILITY, Math.max(MIN_IDLE_PROBABILITY, resumedWithinTtl / eligibleGaps.length));
}

export function decideCacheWarming(
	event: CacheWarmingDecisionEvent,
	ctx: Pick<ExtensionContext, "sessionManager">,
	now = Date.now(),
): CacheWarmingDecisionEventResult {
	let continuationProbability = 1;
	if (event.phase === "idle") {
		continuationProbability =
			event.profile === "auto"
				? getAutoContinuationProbability(ctx.sessionManager, now, event.ttlMs)
				: MIN_IDLE_PROBABILITY;
	}

	const expectedSavings =
		continuationProbability * event.costs.missPenalty - event.cumulativeWarmCost - event.costs.nextWarm;
	return {
		action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		continuationProbability,
		expectedSavings,
		minimumExpectedSavings: CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	};
}

export default function cacheWarmingExtension(pi: ExtensionAPI): void {
	pi.on("cache_warming_decision", (event, ctx) => decideCacheWarming(event, ctx));
}
