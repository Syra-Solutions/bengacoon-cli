import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CacheWarmingDecisionEvent } from "../src/core/cache-warmer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { type ReadonlySessionManager, SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";
import cacheWarmingExtension, {
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	decideCacheWarming,
	getAutoContinuationProbability,
} from "../src/extensions/cache-warming.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

function sessionWithUserMessages(...timestamps: number[]): ReadonlySessionManager {
	const entries: SessionMessageEntry[] = timestamps.map((timestamp, index) => ({
		type: "message",
		id: String(index),
		parentId: index === 0 ? null : String(index - 1),
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: "test", timestamp } satisfies UserMessage,
	}));
	return { getBranch: () => entries } as unknown as ReadonlySessionManager;
}

function event(overrides: Partial<CacheWarmingDecisionEvent> = {}): CacheWarmingDecisionEvent {
	return {
		type: "cache_warming_decision",
		profile: "idle",
		phase: "idle",
		model: { provider: "test", id: "model" },
		ttlMs: 300_000,
		promptTokens: 100_000,
		costs: { cacheHit: 0.025, cacheMiss: 1.25, missPenalty: 1.225, nextWarm: 0.025 },
		cumulativeWarmCost: 0,
		continuationProbability: 0,
		expectedSavings: 0,
		minimumExpectedSavings: 0,
		defaultAction: "stop",
		...overrides,
	};
}

describe("cache-warming policy extension", () => {
	it("uses certainty during active runs and 25% after idle settles", () => {
		const ctx = { sessionManager: sessionWithUserMessages(0) };
		const streaming = decideCacheWarming(event({ phase: "streaming" }), ctx);
		const idle = decideCacheWarming(event(), ctx);

		expect(streaming).toMatchObject({ action: "warm", continuationProbability: 1 });
		expect(idle).toMatchObject({ action: "warm", continuationProbability: 0.25 });
		expect(idle.minimumExpectedSavings).toBe(CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS);
	});

	it("stops when cumulative warming cost consumes expected savings", () => {
		const result = decideCacheWarming(
			event({
				cumulativeWarmCost: 0.25,
				costs: { cacheHit: 0.025, cacheMiss: 1, missPenalty: 0.975, nextWarm: 0.025 },
			}),
			{ sessionManager: sessionWithUserMessages(0) },
		);

		expect(result.action).toBe("stop");
		expect(result.expectedSavings).toBeCloseTo(-0.03125);
	});

	it("estimates auto continuation from user-message gaps and clamps it to 25-75%", () => {
		const session = sessionWithUserMessages(0, 150, 300, 450, 1_000);
		expect(getAutoContinuationProbability(session, 1_100, 200)).toBe(0.75);
		expect(getAutoContinuationProbability(sessionWithUserMessages(1_000), 1_100, 200)).toBe(0.25);

		const result = decideCacheWarming(event({ profile: "auto", ttlMs: 200 }), { sessionManager: session }, 1_100);
		expect(result.continuationProbability).toBe(0.75);
	});

	it("requires the configured reserve even when expected savings are positive", () => {
		const result = decideCacheWarming(
			event({ costs: { cacheHit: 0.01, cacheMiss: 0.2, missPenalty: 0.19, nextWarm: 0.01 } }),
			{ sessionManager: sessionWithUserMessages(0) },
		);
		expect(result.expectedSavings).toBeCloseTo(0.0375);
		expect(result.action).toBe("stop");
	});

	it("runs the bundled policy before user extension overrides", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const bundled = await loadExtensionFromFactory(cacheWarmingExtension, process.cwd(), eventBus, runtime);
		bundled.hidden = true;
		let observed: CacheWarmingDecisionEvent | undefined;
		const override: ExtensionFactory = (pi) => {
			pi.on("cache_warming_decision", (candidate) => {
				observed = { ...candidate };
				return { action: "stop" };
			});
		};
		const custom = await loadExtensionFromFactory(override, process.cwd(), eventBus, runtime);
		const runner = new ExtensionRunner(
			[bundled, custom],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);

		const action = await runner.emitCacheWarmingDecision(event({ phase: "streaming" }));
		expect(observed).toMatchObject({
			continuationProbability: 1,
			defaultAction: "warm",
			minimumExpectedSavings: CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
		});
		expect(action).toBe("stop");
	});
});
