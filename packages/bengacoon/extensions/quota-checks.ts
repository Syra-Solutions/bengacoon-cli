import assert from "node:assert/strict";
import bengacoon from "./bengacoon.ts";
import { fetchCodexQuota, parseCodexQuotaResponse } from "./quota.ts";

const NOW = 1_788_600_000_000;
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
const payload = {
	plan_type: "pro",
	rate_limit: {
		primary_window: { used_percent: 62, limit_window_seconds: 18_000, reset_at: 1_788_620_161 },
		secondary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: 1_789_206_961 },
	},
	additional_rate_limits: [
		{
			limit_name: "codex_spark",
			rate_limit: {
				primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 18_000 },
			},
		},
	],
};

assert.deepEqual(parseCodexQuotaResponse(payload, NOW), {
	plan: "pro",
	limits: [
		{
			name: "codex",
			windows: [
				{ label: "5h", remainingPercent: 38, resetAt: 1_788_620_161_000 },
				{ label: "week", remainingPercent: 69, resetAt: 1_789_206_961_000 },
			],
		},
		{
			name: "codex_spark",
			windows: [{ label: "5h", remainingPercent: 88, resetAt: NOW + 18_000_000 }],
		},
	],
});

let request;
const quota = await fetchCodexQuota(token, async (url, options) => {
	request = { url, options };
	return new Response(JSON.stringify(payload), { status: 200 });
}, NOW);

assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
assert.deepEqual(request.options.headers, {
	Authorization: `Bearer ${token}`,
	"chatgpt-account-id": "account-123",
	originator: "pi",
	"User-Agent": "bengacoon",
});
assert.deepEqual(quota, parseCodexQuotaResponse(payload, NOW));
assert.equal(await fetchCodexQuota(undefined, fetch, NOW), undefined);

const endpointPayload = { ...payload, additional_rate_limits: [] };
const handlers = new Map();
bengacoon({
	on(event, handler) {
		handlers.set(event, handler);
	},
	registerMessageRenderer() {},
	registerTool() {},
	registerCommand() {},
});
const afterProviderResponse = handlers.get("after_provider_response");
assert.equal(typeof afterProviderResponse, "function");
let resolveQuotaStatus;
const quotaStatus = new Promise((resolve) => {
	resolveQuotaStatus = resolve;
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify(endpointPayload), { status: 200 });
let authRequests = 0;
try {
	afterProviderResponse(
		{ headers: {} },
		{
			model: { provider: "openai-codex" },
			modelRegistry: {
				getApiKeyForProvider: async () => {
					authRequests += 1;
					return token;
				},
			},
			ui: {
				setStatus(key, _text, metadata) {
					if (key === "bengacoon-quota") resolveQuotaStatus(metadata.values.usage);
				},
			},
		},
	);
	assert.equal(authRequests, 1);
	assert.deepEqual(JSON.parse(await quotaStatus), parseCodexQuotaResponse(endpointPayload, NOW));
} finally {
	globalThis.fetch = originalFetch;
}
