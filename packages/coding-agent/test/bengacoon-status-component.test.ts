import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { BengacoonStatusSnapshot } from "../src/core/bengacoon-status.ts";
import { BengacoonStatusComponent } from "../src/modes/interactive/components/bengacoon-status.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const snapshot: BengacoonStatusSnapshot = {
	branch: "feat/responsive-bengacoon-sidebar",
	usage: { inputTokens: 12_400, outputTokens: 2_100, cost: 0.42 },
	context: { remainingTokens: 75_000, remainingPercent: 75 },
	changes: {
		total: 2,
		added: 42,
		removed: 7,
		details: ["api.ts +31 -4", "test.ts +11 -3"],
	},
	delivery: {
		title: "Delivery observability",
		criterion: "The sidebar shows the active work item.",
		verification: "prove-red proven",
		receipt: "matches",
		nextStep: "Commit the delivery unit.",
	},
	jobs: {
		total: 4,
		active: 1,
		failed: 1,
		details: ["a1b2c3d4 running Repository exploration", "e5f6a7b8 failed Repository verification"],
	},
	quota: {
		plan: "pro",
		limits: [
			{
				name: "codex",
				limitReached: false,
				windows: [
					{ label: "5h", usedPercent: 40, remainingPercent: 60, resetAt: 1_788_620_161_000 },
					{ label: "week", usedPercent: 80, remainingPercent: 20, resetAt: 1_789_206_961_000 },
				],
			},
			{
				name: "codex_spark",
				limitReached: true,
				windows: [{ label: "5h", usedPercent: 100, remainingPercent: 0, resetAt: 1_788_620_161_000 }],
			},
		],
	},
};

describe("Bengacoon status component", () => {
	it("renders every snapshot section inside the 36-column sidebar", () => {
		initTheme("cyber-coon");
		const component = new BengacoonStatusComponent(() => snapshot, "sidebar");
		const lines = component.render(36);
		const text = lines.map(stripTerminalSequences).join("\n");

		expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
		expect(lines).toContain(theme.fg("accent", "╭─  Git"));
		expect(lines.some((line) => line.includes(theme.fg("muted", "Branch")))).toBe(true);
		expect(text).toContain("╭─  Git");
		expect(text).toContain("│ Branch");
		expect(text).toContain("╭─ ⚙ AI usage");
		expect(text).toContain("│ Input");
		expect(text).toContain("╭─ ◷ Context");
		expect(text).toContain("│ Remaining");
		expect(text).toContain("╭─ ▣ Delivery");
		expect(text).toContain("│ Work     Delivery observability");
		expect(text).toContain("│ Verify   prove-red proven");
		expect(text).toContain("│ Receipt  matches");
		expect(text).toContain("╭─ ✎ Changes");
		expect(text).toContain("│ Summary  2 files · +42 -7");
		expect(text).toContain("│ File     api.ts +31 -4");
		expect(text).toContain("╭─ ↻ Jobs");
		expect(text).toContain("│ Summary  4 total · 1 active · 1");
		expect(text).toContain("│          failed");
		expect(text).toContain("│ Detail   a1b2c3d4 running");
		expect(text).toContain("│ Detail   e5f6a7b8 failed");
		expect(text).toContain("╭─ ◐ Quota");
		expect(text).toContain("│ Plan     pro");
		expect(text).toContain("│ codex 5h ████░░░░░░ 40%");
		expect(text).toContain("│ Remaining 60% remaining");
		expect(text).toContain("│ Reset    2026-09-05 14:56:01 UTC");
		expect(text).toContain("│ Status   Available");
		expect(text).toContain("│ codex_spark 5h ██████████ 100%");
		expect(text).toContain("│ Status   Limit reached");
	});

	it("collapses delivery to its active work", () => {
		initTheme("cyber-coon");
		const component = new BengacoonStatusComponent(() => snapshot, "sidebar");
		component.toggleDeliveryCollapsed();
		const text = component.render(36).map(stripTerminalSequences).join("\n");

		expect(text).toContain("╭─ ▣ Delivery");
		expect(text).toContain("│ Work     Delivery observability");
		expect(text).not.toContain("Acceptance");
		expect(text).not.toContain("Verify");
		expect(text).not.toContain("Receipt");
		expect(text).not.toContain("Next");
	});

	it("fills the context bar from used context", () => {
		initTheme("cyber-coon");
		const component = new BengacoonStatusComponent(
			() => ({ ...snapshot, context: { remainingTokens: 18_300, remainingPercent: 18.3 } }),
			"sidebar",
		);
		const text = component.render(36).map(stripTerminalSequences).join("\n");

		expect(text).toContain("│ Used     ████████░░ 81.7%");
	});

	it("renders a readable multiline footer and skips snapshot work when hidden", () => {
		const getSnapshot = vi.fn(() => snapshot);
		const footer = new BengacoonStatusComponent(getSnapshot, "footer", () => true);
		const hidden = new BengacoonStatusComponent(getSnapshot, "footer", () => false);
		const lines = footer.render(80).map(stripTerminalSequences);

		expect(lines.length).toBeGreaterThanOrEqual(5);
		expect(lines.join("\n")).toContain("Branch:");
		expect(lines.join("\n")).toContain("AI:");
		expect(lines.join("\n")).toContain("Context:");
		expect(lines.join("\n")).toContain("Delivery:");
		expect(lines.join("\n")).toContain("Jobs:");
		expect(lines.join("\n")).toContain("a1b2c3d4 running");
		expect(lines.join("\n")).toContain("e5f6a7b8 failed");
		expect(lines.join("\n")).toContain("Quota:");
		expect(hidden.render(80)).toEqual([]);
		expect(getSnapshot).toHaveBeenCalledTimes(1);
	});
});
