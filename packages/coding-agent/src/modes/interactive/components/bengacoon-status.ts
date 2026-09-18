import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BengacoonStatusSnapshot } from "../../../core/bengacoon-status.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

export type BengacoonStatusLayout = "sidebar" | "footer";

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function availablePercent(value: number): string {
	return `${formatPercent(value)}% remaining`;
}

function quotaRows(snapshot: BengacoonStatusSnapshot): [label: string, value: string][] {
	const { plan, limits } = snapshot.quota;
	if (limits.length === 0) return [["Usage", "Unavailable"]];
	return [
		...(plan === null ? [] : [["Plan", plan] as [string, string]]),
		...limits.flatMap((limit) =>
			limit.windows.flatMap((window) => [
				[`${limit.name} ${window.label}`, usageBar(window.usedPercent)] as [string, string],
				["Remaining", availablePercent(window.remainingPercent)] as [string, string],
				[
					"Reset",
					window.resetAt === null
						? "Unavailable"
						: new Date(window.resetAt).toISOString().replace("T", " ").replace(".000Z", " UTC"),
				] as [string, string],
				["Status", limit.limitReached ? "Limit reached" : "Available"] as [string, string],
			]),
		),
	];
}

function quotaSummary(snapshot: BengacoonStatusSnapshot): string {
	const rows = quotaRows(snapshot);
	return rows.map(([label, value]) => `${label} ${value}`).join(" · ");
}

function contextRemaining(snapshot: BengacoonStatusSnapshot): string {
	const { remainingTokens, remainingPercent } = snapshot.context;
	if (remainingTokens === null || remainingPercent === null) return "Unavailable";
	return `${formatTokens(remainingTokens)} tokens · ${formatPercent(remainingPercent)}%`;
}

function usageBar(usedPercent: number): string {
	const boundedPercent = Math.min(100, Math.max(0, usedPercent));
	const filledBlocks = Math.round(boundedPercent / 10);
	return `${theme.fg("success", "█".repeat(filledBlocks))}${theme.fg("dim", "░".repeat(10 - filledBlocks))} ${formatPercent(boundedPercent)}%`;
}

function contextUsageBar(snapshot: BengacoonStatusSnapshot): string {
	const remainingPercent = snapshot.context.remainingPercent;
	return remainingPercent === null ? "Unavailable" : usageBar(100 - remainingPercent);
}

function jobSummary(snapshot: BengacoonStatusSnapshot): string {
	return `${snapshot.jobs.total} total · ${snapshot.jobs.active} active · ${snapshot.jobs.failed} failed`;
}

function wrapLogicalLines(lines: readonly string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	return lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, safeWidth)));
}

function sidebarRow(label: string, value: string, width: number): string[] {
	const labelColumnWidth = Math.max(8, label.length);
	const valueWidth = Math.max(1, width - 2 - labelColumnWidth - 1);
	const valueLines = wrapTextWithAnsi(value, valueWidth);
	const firstPrefix = `${theme.fg("border", "│")} ${theme.fg("muted", label)}${" ".repeat(labelColumnWidth - label.length)} `;
	const restPrefix = `${theme.fg("border", "│")} ${" ".repeat(labelColumnWidth)} `;
	return valueLines.map((line, index) => `${index === 0 ? firstPrefix : restPrefix}${theme.fg("text", line)}`);
}

function sidebarCard(title: string, rows: readonly [label: string, value: string][], width: number): string[] {
	return [
		theme.fg("accent", `╭─ ${title}`),
		...rows.flatMap(([label, value]) => sidebarRow(label, value, width)),
		theme.fg("border", `╰${"─".repeat(Math.max(0, width - 1))}`),
	];
}

function sidebarLines(snapshot: BengacoonStatusSnapshot, width: number): string[] {
	const safeWidth = Math.max(1, width);
	return [
		...sidebarCard(" Git", [["Branch", snapshot.branch ?? "Unavailable"]], safeWidth),
		"",
		...sidebarCard(
			"⚙ AI usage",
			[
				["Input", formatTokens(snapshot.usage.inputTokens)],
				["Output", formatTokens(snapshot.usage.outputTokens)],
				["Cost", `$${snapshot.usage.cost.toFixed(3)}`],
			],
			safeWidth,
		),
		"",
		...sidebarCard(
			"◷ Context",
			[
				["Remaining", contextRemaining(snapshot)],
				["Used", contextUsageBar(snapshot)],
			],
			safeWidth,
		),
		"",
		...sidebarCard(
			"↻ Jobs",
			[
				["Summary", jobSummary(snapshot)],
				...snapshot.jobs.details.map((detail) => ["Detail", detail] as [string, string]),
			],
			safeWidth,
		),
		"",
		...sidebarCard("◐ Quota", quotaRows(snapshot), safeWidth),
	];
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
			`Quota: ${quotaSummary(snapshot)}`,
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
