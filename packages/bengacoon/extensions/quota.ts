const DAILY_WINDOW_MINUTES = 24 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * DAILY_WINDOW_MINUTES;

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
