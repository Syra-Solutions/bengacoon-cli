const DAILY_WINDOW_MINUTES = 24 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * DAILY_WINDOW_MINUTES;
const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const WEEK_SECONDS = 7 * DAY_SECONDS;
// This internal endpoint matches the Codex CLI usage request; failure leaves quota unavailable.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

function usageWindowLabel(seconds) {
  if (seconds === WEEK_SECONDS) return "week";
  if (seconds >= DAY_SECONDS && seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
  if (seconds >= HOUR_SECONDS && seconds % HOUR_SECONDS === 0) return `${seconds / HOUR_SECONDS}h`;
  return `${Math.round(seconds / 60)}m`;
}

function parseUsageWindow(raw, now) {
  if (!raw || typeof raw !== "object") return undefined;
  const usedPercent = percent(raw.used_percent);
  const windowSeconds = raw.limit_window_seconds;
  if (usedPercent === undefined || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return undefined;
  const resetAt = Number.isFinite(raw.reset_at)
    ? raw.reset_at * 1000
    : Number.isFinite(raw.reset_after_seconds)
      ? now + raw.reset_after_seconds * 1000
      : null;
  return { label: usageWindowLabel(windowSeconds), remainingPercent: 100 - usedPercent, resetAt };
}

function parseUsageLimit(name, raw, now) {
  if (!raw || typeof raw !== "object") return undefined;
  const windows = [parseUsageWindow(raw.primary_window, now), parseUsageWindow(raw.secondary_window, now)].filter(Boolean);
  return windows.length > 0 ? { name, windows } : undefined;
}

export function parseCodexQuotaResponse(payload, now) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const limits = [];
  const main = parseUsageLimit("codex", raw.rate_limit, now);
  if (main) limits.push(main);
  if (Array.isArray(raw.additional_rate_limits)) {
    for (const additional of raw.additional_rate_limits) {
      if (!additional || typeof additional !== "object") continue;
      const limit = parseUsageLimit(
        typeof additional.limit_name === "string" ? additional.limit_name : "limit",
        additional.rate_limit,
        now,
      );
      if (limit) limits.push(limit);
    }
  }
  return { plan: typeof raw.plan_type === "string" ? raw.plan_type : null, limits };
}

function accountIdFromToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const auth = claims?.[CODEX_ACCOUNT_CLAIM];
    return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id.length > 0
      ? auth.chatgpt_account_id
      : undefined;
  } catch {
    // A malformed OAuth token cannot identify an account for this optional request.
    return undefined;
  }
}

export async function fetchCodexQuota(token, fetchFn, now) {
  if (!token) return undefined;
  const accountId = accountIdFromToken(token);
  if (!accountId) return undefined;
  try {
    const response = await fetchFn(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "chatgpt-account-id": accountId,
        originator: "pi",
        "User-Agent": "bengacoon",
      },
    });
    if (!response.ok) return undefined;
    return parseCodexQuotaResponse(await response.json(), now);
  } catch {
    // Quota is informational; an unavailable internal endpoint must not interrupt a model response.
    return undefined;
  }
}

function headerValue(headers, name) {
  const direct = headers?.[name];
  if (typeof direct === "string") return direct;
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return typeof match?.[1] === "string" ? match[1] : undefined;
}

function percent(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

function remainingFromUsed(value) {
  const used = percent(value);
  return used === undefined ? undefined : 100 - used;
}

function directRemaining(headers, period) {
  return (
    percent(headerValue(headers, `x-codex-${period}-remaining-percent`)) ??
    remainingFromUsed(headerValue(headers, `x-codex-${period}-used-percent`))
  );
}

function classifyWindow(headers, name) {
  const used = remainingFromUsed(headerValue(headers, `x-codex-${name}-used-percent`));
  const minutes = Number(headerValue(headers, `x-codex-${name}-window-minutes`));
  if (used === undefined || !Number.isFinite(minutes)) return undefined;
  if (minutes === DAILY_WINDOW_MINUTES) return { period: "daily", remaining: used };
  if (minutes === WEEKLY_WINDOW_MINUTES) return { period: "weekly", remaining: used };
  return undefined;
}

export function parseCodexQuotaHeaders(headers) {
  let dailyRemainingPercent = directRemaining(headers, "daily");
  let weeklyRemainingPercent = directRemaining(headers, "weekly");

  for (const window of [classifyWindow(headers, "primary"), classifyWindow(headers, "secondary")]) {
    if (window?.period === "daily" && dailyRemainingPercent === undefined) {
      dailyRemainingPercent = window.remaining;
    }
    if (window?.period === "weekly" && weeklyRemainingPercent === undefined) {
      weeklyRemainingPercent = window.remaining;
    }
  }

  if (dailyRemainingPercent === undefined && weeklyRemainingPercent === undefined) return undefined;
  return { dailyRemainingPercent, weeklyRemainingPercent };
}
