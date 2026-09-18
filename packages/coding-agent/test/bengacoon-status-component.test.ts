import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { BengacoonStatusSnapshot } from "../src/core/bengacoon-status.ts";
import { BengacoonStatusComponent } from "../src/modes/interactive/components/bengacoon-status.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const snapshot: BengacoonStatusSnapshot = {
	branch: "feat/responsive-bengacoon-sidebar",
	usage: { inputTokens: 12_400, outputTokens: 2_100, cost: 0.42 },
	context: { remainingTokens: 75_000, remainingPercent: 75 },
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
				windows: [
					{ label: "5h", remainingPercent: 60, resetAt: 1_788_620_161_000 },
					{ label: "week", remainingPercent: 20, resetAt: 1_789_206_961_000 },
				],
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
		expect(text).toContain("╭─ ↻ Jobs");
		expect(text).toContain("│ Summary  4 total · 1 active · 1");
		expect(text).toContain("│          failed");
		expect(text).toContain("│ Detail   a1b2c3d4 running");
		expect(text).toContain("│ Detail   e5f6a7b8 failed");
		expect(text).toContain("╭─ ◐ Quota");
		expect(text).toContain("│ Plan     pro");
		expect(text).toContain("│ codex    5h 60% remaining");
		expect(text).toContain("│ codex    week 20% remaining");
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
		expect(lines.join("\n")).toContain("Jobs:");
		expect(lines.join("\n")).toContain("a1b2c3d4 running");
		expect(lines.join("\n")).toContain("e5f6a7b8 failed");
		expect(lines.join("\n")).toContain("Quota:");
		expect(hidden.render(80)).toEqual([]);
		expect(getSnapshot).toHaveBeenCalledTimes(1);
	});
});
