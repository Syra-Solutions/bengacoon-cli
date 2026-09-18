import type { SessionStats } from "./agent-session.ts";
import type { ExtensionStatusMetadata } from "./footer-data-provider.ts";

const JOBS_STATUS_KEY = "bengacoon-jobs";
const QUOTA_STATUS_KEY = "bengacoon-quota";
const DELIVERY_STATUS_KEY = "bengacoon-delivery";
const CHANGES_STATUS_KEY = "bengacoon-changes";

interface StatusSession {
	getSessionStats(): SessionStats;
}

interface StatusMetadataSource {
	getGitBranch(): string | null;
	getExtensionStatusMetadata(): ReadonlyMap<string, ExtensionStatusMetadata>;
}

export interface BengacoonStatusSnapshot {
	readonly branch: string | null;
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cost: number;
	};
	readonly context: {
		readonly remainingTokens: number | null;
		readonly remainingPercent: number | null;
	};
	readonly jobs: {
		readonly total: number;
		readonly active: number;
		readonly failed: number;
		readonly details: readonly string[];
	};
	readonly changes: {
		readonly total: number;
		readonly added: number;
		readonly removed: number;
		readonly details: readonly string[];
	};
	readonly delivery: {
		readonly title: string;
		readonly criterion: string;
		readonly verification: string;
		readonly receipt: "missing" | "matches" | "stale" | "unavailable";
		readonly nextStep: string;
	} | null;
	readonly quota: {
		readonly plan: string | null;
		readonly limits: readonly {
			readonly name: string;
			readonly limitReached: boolean;
			readonly windows: readonly {
				readonly label: string;
				readonly usedPercent: number;
				readonly remainingPercent: number;
				readonly resetAt: number | null;
			}[];
		}[];
	};
}

function parseNonNegativeInteger(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseChanges(value: string | undefined): BengacoonStatusSnapshot["changes"] {
	if (!value) return { total: 0, added: 0, removed: 0, details: [] };
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed) || !Array.isArray(parsed.details)) return { total: 0, added: 0, removed: 0, details: [] };
		return {
			total: typeof parsed.total === "number" && parsed.total >= 0 ? parsed.total : 0,
			added: typeof parsed.added === "number" && parsed.added >= 0 ? parsed.added : 0,
			removed: typeof parsed.removed === "number" && parsed.removed >= 0 ? parsed.removed : 0,
			details: parsed.details.filter((detail): detail is string => typeof detail === "string"),
		};
	} catch {
		return { total: 0, added: 0, removed: 0, details: [] };
	}
}

function parseDeliveryStatus(value: string | undefined): BengacoonStatusSnapshot["delivery"] {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			!isRecord(parsed) ||
			typeof parsed.title !== "string" ||
			typeof parsed.criterion !== "string" ||
			typeof parsed.verification !== "string" ||
			typeof parsed.nextStep !== "string" ||
			(parsed.receipt !== "missing" &&
				parsed.receipt !== "matches" &&
				parsed.receipt !== "stale" &&
				parsed.receipt !== "unavailable")
		)
			return null;
		return {
			title: parsed.title,
			criterion: parsed.criterion,
			verification: parsed.verification,
			receipt: parsed.receipt,
			nextStep: parsed.nextStep,
		};
	} catch {
		return null;
	}
}

function parseQuotaUsage(value: string | undefined): BengacoonStatusSnapshot["quota"] {
	if (!value) return { plan: null, limits: [] };
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed) || !Array.isArray(parsed.limits)) return { plan: null, limits: [] };
		const limits = parsed.limits.flatMap((limit) => {
			if (
				!isRecord(limit) ||
				typeof limit.name !== "string" ||
				typeof limit.limitReached !== "boolean" ||
				!Array.isArray(limit.windows)
			)
				return [];
			const windows = limit.windows.flatMap((window) => {
				if (
					!isRecord(window) ||
					typeof window.label !== "string" ||
					typeof window.usedPercent !== "number" ||
					typeof window.remainingPercent !== "number"
				)
					return [];
				if (
					!Number.isFinite(window.usedPercent) ||
					window.usedPercent < 0 ||
					window.usedPercent > 100 ||
					!Number.isFinite(window.remainingPercent) ||
					window.remainingPercent < 0 ||
					window.remainingPercent > 100
				)
					return [];
				const resetAt =
					typeof window.resetAt === "number" && Number.isFinite(window.resetAt) ? window.resetAt : null;
				return [
					{
						label: window.label,
						usedPercent: window.usedPercent,
						remainingPercent: window.remainingPercent,
						resetAt,
					},
				];
			});
			return windows.length > 0 ? [{ name: limit.name, limitReached: limit.limitReached, windows }] : [];
		});
		return { plan: typeof parsed.plan === "string" ? parsed.plan : null, limits };
	} catch {
		return { plan: null, limits: [] };
	}
}

export function createBengacoonStatusSnapshot(
	session: StatusSession,
	metadataSource: StatusMetadataSource,
): BengacoonStatusSnapshot {
	const stats = session.getSessionStats();
	const contextUsage = stats.contextUsage;
	let remainingTokens: number | null = null;
	let remainingPercent: number | null = null;
	if (contextUsage && contextUsage.tokens !== null && contextUsage.percent !== null) {
		remainingTokens = Math.max(0, contextUsage.contextWindow - contextUsage.tokens);
		remainingPercent = Math.max(0, Math.min(100, 100 - contextUsage.percent));
	}
	const metadata = metadataSource.getExtensionStatusMetadata();
	const jobMetadata = metadata.get(JOBS_STATUS_KEY);
	const quotaMetadata = metadata.get(QUOTA_STATUS_KEY);
	const deliveryMetadata = metadata.get(DELIVERY_STATUS_KEY);
	const changesMetadata = metadata.get(CHANGES_STATUS_KEY);

	return {
		branch: metadataSource.getGitBranch(),
		usage: {
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cost: stats.cost,
		},
		context: { remainingTokens, remainingPercent },
		jobs: {
			total: parseNonNegativeInteger(jobMetadata?.values?.total),
			active: parseNonNegativeInteger(jobMetadata?.values?.active),
			failed: parseNonNegativeInteger(jobMetadata?.values?.failed),
			details: [...(jobMetadata?.lines ?? [])],
		},
		changes: parseChanges(changesMetadata?.values?.changes),
		delivery: parseDeliveryStatus(deliveryMetadata?.values?.delivery),
		quota: parseQuotaUsage(quotaMetadata?.values?.usage),
	};
}
