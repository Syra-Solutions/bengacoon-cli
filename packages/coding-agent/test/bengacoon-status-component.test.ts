import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { BengacoonStatusSnapshot } from "../src/core/bengacoon-status.ts";
import { BengacoonStatusComponent } from "../src/modes/interactive/components/bengacoon-status.ts";

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
	quota: { dailyRemainingPercent: 60, weeklyRemainingPercent: null },
};

describe("Bengacoon status component", () => {
	it("renders every snapshot section inside the 36-column sidebar", () => {
		const component = new BengacoonStatusComponent(() => snapshot, "sidebar");
		const lines = component.render(36);
		const text = lines.map(stripTerminalSequences).join("\n");

		expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
		expect(text).toContain("Branch");
		expect(text).toContain("AI usage");
		expect(text).toContain("Context remaining");
		expect(text).toContain("Jobs 4 total · 1 active · 1 failed");
		expect(text).toContain("a1b2c3d4 running");
		expect(text).toContain("e5f6a7b8 failed");
		expect(text).toContain("Daily 60% remaining");
		expect(text).toContain("Weekly Unavailable");
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
