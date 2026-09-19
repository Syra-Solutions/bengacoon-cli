import { type Component, type TuiMouseEvent, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

function changesRows(snapshot: BengacoonStatusSnapshot): [label: string, value: string][] {
	const { unavailable, total, added, removed, details } = snapshot.changes;
	if (unavailable) return [["Summary", "Unavailable"]];
	return [
		["Summary", `${total} files · +${added} -${removed}`],
		...details.map((detail) => ["File", detail] as [string, string]),
	];
}

function deliveryRows(snapshot: BengacoonStatusSnapshot): [label: string, value: string][] {
	const delivery = snapshot.delivery;
	if (delivery === null) return [["Status", "No active delivery unit"]];
	return [
		["Work", delivery.title],
		["Acceptance", delivery.criterion],
		["Verify", delivery.verification],
		["Receipt", delivery.receipt],
		["Next", delivery.nextStep],
	];
}

function deliverySummary(snapshot: BengacoonStatusSnapshot): string {
	const delivery = snapshot.delivery;
	return delivery === null
		? "No active delivery unit"
		: `${delivery.title} · ${delivery.verification} · receipt ${delivery.receipt}`;
}

function jobSummary(snapshot: BengacoonStatusSnapshot): string {
	return `${snapshot.jobs.total} total · ${snapshot.jobs.active} active · ${snapshot.jobs.failed} failed`;
}

function changesSummary(snapshot: BengacoonStatusSnapshot): string {
	const { unavailable, total, added, removed } = snapshot.changes;
	return unavailable ? "Unavailable" : `${total} files · +${added} -${removed}`;
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

type SidebarCardId = "git" | "usage" | "context" | "delivery" | "changes" | "jobs" | "quota";

interface SidebarCard {
	readonly id: SidebarCardId;
	readonly title: string;
	readonly rows: readonly [label: string, value: string][];
}

function sidebarCards(snapshot: BengacoonStatusSnapshot): readonly SidebarCard[] {
	return [
		{ id: "git", title: " Git", rows: [["Branch", snapshot.branch ?? "Unavailable"]] },
		{
			id: "usage",
			title: "⚙ AI usage",
			rows: [
				["Input", formatTokens(snapshot.usage.inputTokens)],
				["Output", formatTokens(snapshot.usage.outputTokens)],
				["Cost", `$${snapshot.usage.cost.toFixed(3)}`],
			],
		},
		{
			id: "context",
			title: "◷ Context",
			rows: [
				["Remaining", contextRemaining(snapshot)],
				["Used", contextUsageBar(snapshot)],
			],
		},
		{ id: "delivery", title: "▣ Delivery", rows: deliveryRows(snapshot) },
		{ id: "changes", title: "✎ Changes", rows: changesRows(snapshot) },
		{
			id: "jobs",
			title: "↻ Jobs",
			rows: [
				["Summary", jobSummary(snapshot)],
				...snapshot.jobs.details.map((detail) => ["Detail", detail] as [string, string]),
			],
		},
		{ id: "quota", title: "◐ Quota", rows: quotaRows(snapshot) },
	];
}

function sidebarCard(card: SidebarCard, width: number, collapsed: boolean): string[] {
	return [
		theme.fg("accent", `╭─ ${collapsed ? "▶" : "▼"} ${card.title}`),
		...(collapsed ? [] : card.rows.flatMap(([label, value]) => sidebarRow(label, value, width))),
		theme.fg("border", `╰${"─".repeat(Math.max(0, width - 1))}`),
	];
}

function sidebarLines(
	snapshot: BengacoonStatusSnapshot,
	width: number,
	collapsedCards: ReadonlySet<SidebarCardId>,
): string[] {
	const safeWidth = Math.max(1, width);
	return sidebarCards(snapshot).flatMap((card, index, cards) => [
		...sidebarCard(card, safeWidth, collapsedCards.has(card.id)),
		...(index === cards.length - 1 ? [] : [""]),
	]);
}

function footerLines(snapshot: BengacoonStatusSnapshot, width: number): string[] {
	const details = snapshot.jobs.details.map((line) => `  ${line}`);
	return wrapLogicalLines(
		[
			`Branch: ${snapshot.branch ?? "Unavailable"}`,
			`AI: input ${formatTokens(snapshot.usage.inputTokens)} · output ${formatTokens(snapshot.usage.outputTokens)} · $${snapshot.usage.cost.toFixed(3)}`,
			`Context: ${contextRemaining(snapshot)} remaining`,
			`Delivery: ${deliverySummary(snapshot)}`,
			`Changes: ${changesSummary(snapshot)}`,
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
	private collapsedCards = new Set<SidebarCardId>();

	constructor(
		getSnapshot: () => BengacoonStatusSnapshot,
		layout: BengacoonStatusLayout,
		isVisible: () => boolean = () => true,
	) {
		this.getSnapshot = getSnapshot;
		this.layout = layout;
		this.isVisible = isVisible;
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (this.layout !== "sidebar" || event.type !== "click" || event.button !== "left" || event.x !== 3)
			return undefined;
		const snapshot = this.getSnapshot();
		const safeWidth = Math.max(1, event.width);
		let startY = 0;
		const cards = sidebarCards(snapshot);
		for (const [index, card] of cards.entries()) {
			if (event.y === startY) {
				if (this.collapsedCards.has(card.id)) this.collapsedCards.delete(card.id);
				else this.collapsedCards.add(card.id);
				return { handled: true };
			}
			startY += sidebarCard(card, safeWidth, this.collapsedCards.has(card.id)).length;
			if (index < cards.length - 1) startY += 1;
		}
		return undefined;
	}

	render(width: number): string[] {
		if (!this.isVisible()) return [];
		const snapshot = this.getSnapshot();
		return this.layout === "sidebar"
			? sidebarLines(snapshot, width, this.collapsedCards)
			: footerLines(snapshot, width);
	}

	invalidate(): void {}
}
