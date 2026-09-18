import type { SessionStats } from "./agent-session.ts";
import type { ExtensionStatusMetadata } from "./footer-data-provider.ts";

const JOBS_STATUS_KEY = "bengacoon-jobs";
const QUOTA_STATUS_KEY = "bengacoon-quota";

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
		quota: parseQuotaUsage(quotaMetadata?.values?.usage),
	};
}
