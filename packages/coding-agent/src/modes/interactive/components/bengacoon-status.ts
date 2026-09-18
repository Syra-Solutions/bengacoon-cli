import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BengacoonStatusSnapshot } from "../../../core/bengacoon-status.ts";
import { formatTokens } from "./footer.ts";

export type BengacoonStatusLayout = "sidebar" | "footer";

function availablePercent(value: number | null): string {
	return value === null ? "Unavailable" : `${Number.isInteger(value) ? value : value.toFixed(1)}% remaining`;
}

function contextRemaining(snapshot: BengacoonStatusSnapshot): string {
	const { remainingTokens, remainingPercent } = snapshot.context;
	if (remainingTokens === null || remainingPercent === null) return "Unavailable";
	const percent = Number.isInteger(remainingPercent) ? remainingPercent : remainingPercent.toFixed(1);
	return `${formatTokens(remainingTokens)} tokens · ${percent}%`;
}

function jobSummary(snapshot: BengacoonStatusSnapshot): string {
	return `${snapshot.jobs.total} total · ${snapshot.jobs.active} active · ${snapshot.jobs.failed} failed`;
}

function wrapLogicalLines(lines: readonly string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	return lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, safeWidth)));
}

function sidebarLines(snapshot: BengacoonStatusSnapshot, width: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	const content = [
		"Bengacoon",
		"",
		"Branch",
		snapshot.branch ?? "Unavailable",
		"",
		"AI usage",
		`Input ${formatTokens(snapshot.usage.inputTokens)}`,
		`Output ${formatTokens(snapshot.usage.outputTokens)}`,
		`Cost $${snapshot.usage.cost.toFixed(3)}`,
		"",
		"Context remaining",
		contextRemaining(snapshot),
		"",
		`Jobs ${jobSummary(snapshot)}`,
		...snapshot.jobs.details,
		"",
		"Available quota",
		`Daily ${availablePercent(snapshot.quota.dailyRemainingPercent)}`,
		`Weekly ${availablePercent(snapshot.quota.weeklyRemainingPercent)}`,
	];
	return wrapLogicalLines(content, innerWidth).map((line) => `│ ${line}`);
}

function footerLines(snapshot: BengacoonStatusSnapshot, width: number): string[] {
	const details = snapshot.jobs.details.map((line) => `  ${line}`);
	return wrapLogicalLines(
		[
			`Branch: ${snapshot.branch ?? "Unavailable"}`,
			`AI: input ${formatTokens(snapshot.usage.inputTokens)} · output ${formatTokens(snapshot.usage.outputTokens)} · $${snapshot.usage.cost.toFixed(3)}`,
			`Context: ${contextRemaining(snapshot)} remaining`,
			`Jobs: ${jobSummary(snapshot)}`,
			...details,
			`Quota: daily ${availablePercent(snapshot.quota.dailyRemainingPercent)} · weekly ${availablePercent(snapshot.quota.weeklyRemainingPercent)}`,
		],
		width,
	);
}

export class BengacoonStatusComponent implements Component {
	private readonly getSnapshot: () => BengacoonStatusSnapshot;
	private readonly layout: BengacoonStatusLayout;
	private readonly isVisible: () => boolean;

	constructor(
		getSnapshot: () => BengacoonStatusSnapshot,
		layout: BengacoonStatusLayout,
		isVisible: () => boolean = () => true,
	) {
		this.getSnapshot = getSnapshot;
		this.layout = layout;
		this.isVisible = isVisible;
	}

	render(width: number): string[] {
		if (!this.isVisible()) return [];
		const snapshot = this.getSnapshot();
		return this.layout === "sidebar" ? sidebarLines(snapshot, width) : footerLines(snapshot, width);
	}

	invalidate(): void {}
}
