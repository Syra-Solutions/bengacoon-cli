import { jobTitleForCategory } from "./storage.ts";

const ACTIVE_STATES = new Set(["queued", "running"]);

function shortId(id) {
  return id.slice(0, 8);
}

function isPossibleOrphan(record) {
  return record.status === "interrupted" && Boolean(record.pid) && record.orphanProcessPresent !== false;
}

export function statusText(records) {
  const active = records.filter((record) => ACTIVE_STATES.has(record.status)).length;
  const failed = records.filter((record) => record.status === "failed").length;
  const orphans = records.filter(isPossibleOrphan).length;
  const orphanSuffix = orphans > 0 ? `, ${orphans} possible orphan${orphans === 1 ? "" : "s"}` : "";
  if (active === 0 && failed === 0) return `jobs: ${records.length} retained${orphanSuffix}`;
  return `jobs: ${active} active, ${failed} failed${orphanSuffix}`;
}

export function formatList(records) {
  if (records.length === 0) return "No Bengacoon jobs for this worktree.";
  return [
    "Bengacoon jobs",
    ...records.map((record) => {
      const timing = record.endedAt || record.startedAt || record.createdAt;
      return `${shortId(record.id)}  ${record.status.padEnd(23)}  ${jobTitleForCategory(record.category)}  ${timing}`;
    }),
    "Use /jobs <id> for detail or /jobs cancel <id> to cancel an active job.",
  ].join("\n");
}

export function formatDetail(record, outputTail = "") {
  const lines = [
    `Bengacoon ${jobTitleForCategory(record.category)} job ${record.id}`,
    `category: ${record.category ?? "exploration"}`,
    `status: ${record.status}`,
    `created: ${record.createdAt}`,
  ];
  if (record.startedAt) lines.push(`started: ${record.startedAt}`);
  if (record.endedAt) lines.push(`ended: ${record.endedAt}`);
  if (typeof record.exitCode === "number") lines.push(`exit code: ${record.exitCode}`);
  if (record.error) lines.push(`error: ${record.error}`);
  if (record.pid) {
    lines.push(`pid: ${record.pid}`);
    if (record.orphanProcessPresent !== undefined) {
      lines.push(
        record.orphanProcessPresent
          ? "orphan check: a process with this id is still present; the operating system reuses process ids, so a present process may be unrelated to this job"
          : "orphan check: no process with this id is currently present",
      );
    }
  }
  lines.push("recent in-session output:", outputTail || "(no output retained for this session)");
  return lines.join("\n");
}
