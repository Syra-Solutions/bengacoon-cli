import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { CacheWarmingNotice } from "../src/core/cache-warmer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "survived" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-fable-5-1",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	diagnostics: [
		{
			type: "anthropic_input_transformations",
			timestamp: 1,
			details: {
				transformations: [
					{
						type: "thinking_dropped",
						path: "messages.2.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.5.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.8.content.0",
						reason: "prefix_binding_mismatch",
					},
				],
			},
		},
	],
};

describe("InteractiveMode assistant diagnostics", () => {
	test("shows Anthropic thinking drops when cache miss notices are enabled", () => {
		const maybeShowAssistantDiagnostics = Reflect.get(InteractiveMode.prototype, "maybeShowAssistantDiagnostics") as (
			this: {
				chatContainer: Container;
				settingsManager: { getShowCacheMissNotices(): boolean };
			},
			message: AssistantMessage,
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		maybeShowAssistantDiagnostics.call(enabled, message);
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Anthropic dropped 3 thinking blocks (details in session)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		maybeShowAssistantDiagnostics.call(disabled, message);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("shows cache-warming outcomes when cache miss notices are enabled", () => {
		const addCacheWarmingNotice = Reflect.get(InteractiveMode.prototype, "addCacheWarmingNotice") as (
			this: {
				chatContainer: Container;
				settingsManager: { getShowCacheMissNotices(): boolean };
			},
			notice: CacheWarmingNotice,
		) => void;
		const notice: CacheWarmingNotice = {
			note: "extension override",
			usage: {
				input: 4,
				output: 1,
				cacheRead: 117_629,
				cacheWrite: 0,
				totalTokens: 117_634,
				cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
			},
		};

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCacheWarmingNotice.call(enabled, notice);
		expect(stripAnsi(enabled.chatContainer.render(120).join("\n"))).toContain(
			"Cache warmed (extension override): $0.029497",
		);

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCacheWarmingNotice.call(disabled, notice);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});
});
