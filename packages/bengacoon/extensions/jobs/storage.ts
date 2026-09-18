import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const JOB_STATES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "termination_unconfirmed",
]);

export const JOB_CATEGORY_TITLES = Object.freeze({
  exploration: "Repository exploration",
  verification: "Repository verification",
});

const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TIMESTAMP_LENGTH = 40;
const MAX_ERROR_LENGTH = 800;
const MAX_RECORDS = 500;
const UNCONFIRMED_TERMINATION_ERROR = "Child termination could not be confirmed.";
const SAFE_TERMINAL_ERRORS = new Set([
  "Previous Bengacoon session ended before this job finished.",
  "Previous Bengacoon session ended before this job finished; its child process was not confirmed stopped.",
  "Unable to start the child Bengacoon process.",
  "Child Bengacoon process reported an execution error.",
  "Job timed out.",
  "Cancelled by user.",
  "Bengacoon session shut down before this job finished.",
  "Child process stopped unsuccessfully.",
  "Child job was stopped by the repository access guard.",
  UNCONFIRMED_TERMINATION_ERROR,
]);

function boundedText(value, limit) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

export function normalizeJobCategory(value) {
  return typeof value === "string" && Object.hasOwn(JOB_CATEGORY_TITLES, value)
    ? value
    : undefined;
}

export function jobTitleForCategory(value) {
  return JOB_CATEGORY_TITLES[normalizeJobCategory(value) ?? "exploration"];
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TIMESTAMP_LENGTH &&
    Number.isFinite(Date.parse(value))
  );
}

export function isSameOrDescendant(candidate, ancestor) {
  if (typeof candidate !== "string" || typeof ancestor !== "string") return false;
  const relation = relative(ancestor, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

export function normalizeRecord(value) {
  if (!value || typeof value !== "object") return undefined;
  if (!UUID_PATTERN.test(value.id) || !JOB_STATES.has(value.status) || !validTimestamp(value.createdAt)) {
    return undefined;
  }

  const category = normalizeJobCategory(value.category) ?? "exploration";
  const record = {
    id: value.id,
    category,
    title: jobTitleForCategory(category),
    status: value.status,
    createdAt: value.createdAt,
  };
  if (validTimestamp(value.startedAt)) record.startedAt = value.startedAt;
  if (Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 4_294_967_295) {
    record.pid = value.pid;
  }
  if (value.status === "termination_unconfirmed") {
    if (value.error !== UNCONFIRMED_TERMINATION_ERROR) return undefined;
    record.error = UNCONFIRMED_TERMINATION_ERROR;
    return record;
  }
  if (validTimestamp(value.endedAt)) record.endedAt = value.endedAt;
  if (Number.isInteger(value.exitCode) && Math.abs(value.exitCode) <= 1_000_000) {
    record.exitCode = value.exitCode;
  }
  if (typeof value.error === "string" && SAFE_TERMINAL_ERRORS.has(value.error)) {
    record.error = boundedText(value.error, MAX_ERROR_LENGTH);
  }
  return record;
}

export function normalizeRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.map(normalizeRecord).filter(Boolean).slice(-MAX_RECORDS);
}

function profilePath(profileDir, worktreeRoot) {
  const namespace = createHash("sha256").update(worktreeRoot).digest("hex");
  return join(profileDir, "bengacoon-jobs", namespace, "jobs.json");
}

async function canonicalExistingPath(path) {
  if (typeof path !== "string" || !path) return undefined;
  return realpath(path);
}

// The worktree is handed in so the profile can be refused when it sits inside it. A child job
// may read anything under the worktree root, so a profile stored there would put the parent's
// own credentials and session files inside the tree the read-only child is allowed to read.
export async function resolveProfileDir(profileDir, agentDir, worktreeRoot) {
  const selected = profileDir || agentDir;
  if (typeof selected !== "string" || !selected) {
    throw new Error("Bengacoon jobs require a Bengacoon profile directory.");
  }

  const defaultProfile = resolve(process.env.HOME || "/", ".pi", "agent");
  let canonicalDefaultProfile = defaultProfile;
  try {
    canonicalDefaultProfile = await realpath(defaultProfile);
  } catch {
    // The lexical canonical location still protects a selected existing descendant.
  }

  const candidates = [profileDir, agentDir].filter((path) => typeof path === "string" && path);
  const canonicalCandidates = await Promise.all(candidates.map(canonicalExistingPath));
  for (const candidate of canonicalCandidates) {
    if (isSameOrDescendant(candidate, canonicalDefaultProfile)) {
      throw new Error("Refusing to store jobs in Pi's default global profile tree.");
    }
  }

  const canonicalProfile = await realpath(selected);
  if (isSameOrDescendant(canonicalProfile, canonicalDefaultProfile)) {
    throw new Error("Refusing to store jobs in Pi's default global profile tree.");
  }
  if (typeof worktreeRoot === "string" && worktreeRoot && isSameOrDescendant(canonicalProfile, worktreeRoot)) {
    throw new Error("Refusing a Bengacoon profile inside the target worktree: child jobs may read it.");
  }
  return canonicalProfile;
}

export async function canonicalWorktree(cwd, requestedCwd) {
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("Bengacoon job target cwd is unavailable.");
  }
  if (requestedCwd !== undefined) {
    if (
      typeof requestedCwd !== "string" ||
      !requestedCwd ||
      requestedCwd.includes("\0") ||
      !requestedCwd.startsWith("/")
    ) {
      throw new Error("Job cwd must be an absolute canonical worktree root.");
    }
  }

  const canonicalCwd = await realpath(cwd);
  const worktreeRoot = await new Promise((resolveRoot, rejectRoot) => {
    execFile(
      "git",
      ["-C", canonicalCwd, "rev-parse", "--show-toplevel"],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          rejectRoot(new Error("Bengacoon jobs require a Git worktree target."));
          return;
        }
        resolveRoot(stdout.trim());
      },
    );
  });
  const canonicalRoot = await realpath(worktreeRoot);

  if (requestedCwd !== undefined) {
    const canonicalRequested = await realpath(requestedCwd);
    if (canonicalRequested !== canonicalRoot) {
      throw new Error("Job cwd must equal this session's canonical worktree root.");
    }
  }

  return canonicalRoot;
}

export class JobStore {
  constructor(profileDir, worktreeRoot) {
    this.file = profilePath(profileDir, worktreeRoot);
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.records)) {
        throw new Error("invalid job records");
      }
      return normalizeRecords(parsed.records);
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      throw new Error(`Unable to load Bengacoon job records: ${error.message}`);
    }
  }

  async save(records) {
    const destination = this.file;
    const safeRecords = normalizeRecords(records);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: safeRecords })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  }
}
