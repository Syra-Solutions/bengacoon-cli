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
		readonly dailyRemainingPercent: number | null;
		readonly weeklyRemainingPercent: number | null;
	};
}

function parseNonNegativeInteger(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parsePercent(value: string | undefined): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
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
		quota: {
			dailyRemainingPercent: parsePercent(quotaMetadata?.values?.dailyRemainingPercent),
			weeklyRemainingPercent: parsePercent(quotaMetadata?.values?.weeklyRemainingPercent),
		},
	};
}
