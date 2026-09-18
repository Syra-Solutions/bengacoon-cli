import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { jobTitleForCategory, normalizeJobCategory } from "./storage.ts";
import { GUARD_BLOCKED_MARKER } from "./child-guard.ts";

const OUTPUT_TAIL_BYTES = 16 * 1024;
const FINAL_RESULT_MAX_LENGTH = 480;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const UNCONFIRMED_TERMINATION_STATUS = "termination_unconfirmed";
const DELIVERY_STATUSES = new Set([...TERMINAL_STATES, UNCONFIRMED_TERMINATION_STATUS]);
const UNCONFIRMED_TERMINATION_ERROR = "Child termination could not be confirmed.";
const GUARD_BLOCKED_ERROR = "Child job was stopped by the repository access guard.";
const UNCONFIRMED_ORPHAN_ERROR =
  "Previous Bengacoon session ended before this job finished; its child process was not confirmed stopped.";
const CHILD_GUARD_PATH = fileURLToPath(new URL("./child-guard.ts", import.meta.url));
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_CONFIRM_MS = 2_000;
const MAX_CONCURRENT_JOBS = 3;

function now() {
  return new Date().toISOString();
}

function appendTail(current, chunk) {
  const next = `${current}${chunk}`;
  return Buffer.byteLength(next, "utf8") <= OUTPUT_TAIL_BYTES
    ? next
    : Buffer.from(next, "utf8").subarray(-OUTPUT_TAIL_BYTES).toString("utf8");
}

function childPrompt(task) {
  return [
    "You are a Bengacoon V1 read-only background job.",
    "Use only the available read, grep, find, and ls tools.",
    "Do not start processes, install dependencies, modify files, or ask another agent to work.",
    "Return concise factual findings with relevant file paths and uncertainty.",
    "End with one line in this exact form: FINAL_RESULT: <a factual summary of at most 400 characters>. Do not repeat the task, include secrets, or include raw logs in that line.",
    "Task:",
    task,
  ].join("\n\n");
}

// Exported so the conformance check can drive the exact invocation a job uses. A check that
// rebuilt these arguments itself would drift from production and then report on a command
// nobody runs — the guard's whole boundary rests on Pi honouring this flag set.
export function childArgumentsForPrompt(prompt, model) {
  return [
    ...(typeof model === "string" && model ? ["--model", model] : []),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--tools",
    "read,grep,find,ls",
    "--extension",
    CHILD_GUARD_PATH,
    "--print",
    "--",
    prompt,
  ];
}

export function childArguments(task, model) {
  return childArgumentsForPrompt(childPrompt(task), model);
}

export function childInvocation(task, model, entrypoint = process.argv[1]) {
  if (typeof entrypoint !== "string" || !entrypoint) {
    throw new Error("Unable to determine the Bengacoon CLI entrypoint for a child job.");
  }
  return {
    command: process.execPath,
    args: [entrypoint, ...childArguments(task, model)],
  };
}

export function childInvocationForPrompt(prompt, model, entrypoint = process.argv[1]) {
  if (typeof entrypoint !== "string" || !entrypoint) {
    throw new Error("Unable to determine the Bengacoon CLI entrypoint for a child job.");
  }
  return {
    command: process.execPath,
    args: [entrypoint, ...childArgumentsForPrompt(prompt, model)],
  };
}

export function validateTask(task) {
  if (typeof task !== "string" || !task.trim() || task.length > 2_000 || task.includes("\0")) {
    throw new Error("Job task must be non-empty, NUL-free, and at most 2000 characters.");
  }
  return task.trim();
}

export function validateJobCategory(category) {
  const normalized = category === undefined ? "exploration" : normalizeJobCategory(category);
  if (!normalized) throw new Error("Job category must be exploration or verification.");
  return normalized;
}

// A detached child leads its own process group, so its pid doubles as the group id and
// a negative pid signals the whole group. That reaches a grandchild the child spawned,
// which signalling the child alone leaves running. Falls back to the direct child when
// the platform has no negative-pid semantics; the close wait stays the confirmation.
function signalChild(child, signal) {
  let signalledGroup = false;
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      signalledGroup = true;
    } catch {
      // No such group, or no permission to signal it. ESRCH here does not mean the child
      // already exited: a child that never became a group leader is alive in another
      // group, so always fall through to the direct signal rather than assuming success.
    }
  }
  if (signalledGroup) return;
  try {
    child.kill(signal);
  } catch {
    // The close wait is the confirmation boundary.
  }
}

// A guard termination exits 0 with no output of its own, so the exit code cannot classify it.
// The marker the guard writes to stderr is the only signal that the job was stopped, not done.
export function wasStoppedByGuard(outputTail) {
  return typeof outputTail === "string" && outputTail.includes(GUARD_BLOCKED_MARKER);
}

// What a Pi session needs to read one repository, and nothing that grants authority anywhere
// else. Inheriting the parent's whole environment handed the child SSH_AUTH_SOCK — an
// authenticated agent socket a read-only repository explorer can never legitimately need —
// along with every other token in the shell. The child has no tool that could use it today;
// this keeps it that way if one ever appears.
const CHILD_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"];

// Model credentials are forwarded by shape rather than by a guessed list of provider names.
// Infrastructure credentials do not use this suffix — AWS spells its own
// AWS_SECRET_ACCESS_KEY and AWS_ACCESS_KEY_ID — so they stay behind.
const CHILD_ENV_CREDENTIAL_PATTERN = /^[A-Z0-9_]+_API_KEY$/;

export function childEnvironment(profileDir, worktreeRoot, source = process.env) {
  const env = {};
  const extra = (source.BENGACOON_CHILD_ENV ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    const allowed =
      CHILD_ENV_NAMES.includes(name) ||
      CHILD_ENV_CREDENTIAL_PATTERN.test(name) ||
      // Bengacoon's own knobs are configuration, not authority, and a job that skipped them
      // would behave differently from the session that started it.
      name.startsWith("BENGACOON_") ||
      extra.includes(name);
    if (allowed) env[name] = value;
  }

  return {
    ...env,
    BENGACOON_CODING_AGENT_DIR: profileDir,
    BENGACOON_CHILD: "1",
    BENGACOON_TARGET_ROOT: worktreeRoot,
  };
}

// The direct child closing does not mean its group is empty. The graceful stop sends SIGTERM
// to the group, and a child that honours it exits straight away — so waitForClose succeeds and
// the escalation to SIGKILL never runs, leaving a process that ignored SIGTERM behind. Sweep
// the group once the child is gone, so nothing it started outlives the job.
//
// This signals a group id belonging to a pid the operating system has just freed, so in
// principle it could be reused. Unlike a pid recovered from disk, which may be hours stale and
// is therefore only ever reported, this runs in the same turn as the close event, and reuse
// would additionally require the new pid to have become a group leader in that window.
function sweepChildGroup(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH means the group is already empty, which is the ordinary case.
  }
}

function terminalMetadata(status, error) {
  return { status, endedAt: now(), ...(error ? { error } : {}) };
}

const TERMINAL_SUMMARIES = {
  completed: "The read-only job completed. Review its details for any follow-up.",
  failed: "The job did not complete. Inspect its details before retrying.",
  cancelled: "The job was cancelled. Start a replacement only if it is still needed.",
  interrupted: "The parent session ended before the job finished. Start a replacement if needed.",
  termination_unconfirmed: "Process termination could not be confirmed. Inspect before retrying.",
};

function parsedTime(value) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

function formatDuration(record, completedAt) {
  const startedAt = parsedTime(record.startedAt) ?? parsedTime(record.createdAt);
  const endedAt = parsedTime(record.endedAt) ?? completedAt;
  if (startedAt === undefined || !Number.isFinite(endedAt)) return "unavailable";

  const seconds = Math.floor(Math.max(0, endedAt - startedAt) / 1000);
  if (seconds < 1) return "under 1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Horizontal whitespace only (\s would match a newline, letting an empty value swallow the
// whole next line of child output — over-redaction that silently destroys legitimate lines).
// Best effort, not a boundary. Pattern matching cannot recognise every shape a credential
// takes, so this narrows what a job detail view can show; it is not what keeps secrets safe.
// The boundaries are the guard, which stops the child leaving the repository, and storage,
// which persists no child output at all.
//
// Everything here matches horizontal whitespace only, so a pattern can never run past the end
// of its line — except the key block, which is legitimately multi-line.
export function redactCredentials(value) {
  return value
    // A private key block, whole where it is complete. A tail can be cut mid-key, so a BEGIN
    // marker with no END means every remaining byte is key material.
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted credential]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, "[redacted credential]")
    .replace(/\b(?:authorization[^\S\r\n]*:[^\S\r\n]*)?bearer[^\S\r\n]+[a-z0-9._~+\/=\-]{8,}/gi, "[redacted credential]")
    // Any scheme, not just http: a database or broker URL carries credentials the same way,
    // and the user component may be empty, as in redis://:password@host.
    .replace(/\b[a-z][a-z0-9+.\-]*:\/\/[^/\s:@]*:[^/\s@]+@/gi, "[redacted credentials]@")
    // The keyword may sit inside a longer key name, as in aws_secret_access_key.
    .replace(/[\w.\-]*(?:api[ _-]?key|secret|token|password|passwd)[\w.\-]*[^\S\r\n]*[:=][^\S\r\n]*[^\s,;]+/gi, "[redacted credential]")
    .replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat)-[a-z0-9_-]{8,}\b/gi, "[redacted credential]")
    .replace(/\bxox[abprs]-[a-z0-9-]{10,}\b/gi, "[redacted credential]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted credential]")
    .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi, "[redacted credential]");
}

export function sanitizeOutputTail(value) {
  if (typeof value !== "string") return "";
  return redactCredentials(
    value
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " "),
  );
}

export function sanitizeFinalResult(value) {
  if (typeof value !== "string") return undefined;
  const sanitized = redactCredentials(
    value
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f]/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FINAL_RESULT_MAX_LENGTH);
  return sanitized || undefined;
}

export function deriveFinalResult(outputTail, task) {
  if (typeof outputTail !== "string") return undefined;
  const candidate = outputTail
    .split(/\r?\n/)
    .reverse()
    .map((line) => line.match(/^\s*FINAL_RESULT\s*:\s*(.+)\s*$/i)?.[1])
    .find(Boolean);
  const result = sanitizeFinalResult(candidate);
  if (!result) return undefined;
  const normalizedTask = typeof task === "string" ? task.replace(/\s+/g, " ").trim().toLowerCase() : "";
  return normalizedTask && result.toLowerCase().includes(normalizedTask) ? undefined : result;
}

export function formatTerminalCompletion(record, completedAt = Date.now()) {
  const id = typeof record.id === "string" && /^[0-9a-f-]{1,64}$/i.test(record.id)
    ? record.id
    : "unknown";
  const status = Object.hasOwn(TERMINAL_SUMMARIES, record.status) ? record.status : "finished";
  const summary = TERMINAL_SUMMARIES[status] ?? "Inspect the job details before taking further action.";
  const result = sanitizeFinalResult(record.finalResult) ?? "No sanitized final result was available.";
  const hint = id === "unknown" ? "Use /jobs for details." : `Use /jobs ${id} for details.`;
  return `Bengacoon ${jobTitleForCategory(record.category)} job ${id}: ${status}. Duration: ${formatDuration(record, completedAt)}. ${summary} Final result: ${result} ${hint}`;
}

export class JobManager {
  constructor(store, worktreeRoot, profileDir, onChange, spawnChild = spawn, onTerminal, onError, modelForCategory) {
    this.store = store;
    this.worktreeRoot = worktreeRoot;
    this.profileDir = profileDir;
    this.onChange = onChange;
    this.spawnChild = spawnChild;
    this.onTerminal = onTerminal;
    this.onError = onError;
    this.modelForCategory = modelForCategory;
    this.records = [];
    this.children = new Map();
    this.tails = new Map();
    this.tasks = new Map();
    this.stopReasons = new Map();
    this.persistQueue = Promise.resolve();
    this.startingJobs = 0;
    this.shuttingDown = false;
  }

  async initialize() {
    this.records = await this.store.load();
    const interrupted = this.records.filter((record) => record.status === "queued" || record.status === "running");
    if (interrupted.length > 0) {
      for (const record of interrupted) {
        const error = record.pid
          ? UNCONFIRMED_ORPHAN_ERROR
          : "Previous Bengacoon session ended before this job finished.";
        Object.assign(record, terminalMetadata("interrupted", error));
        if (record.pid) record.orphanProcessPresent = this.probeOrphan(record.pid);
      }
      await this.persist();
    }
    this.changed();
  }

  probeOrphan(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }

  possibleOrphans() {
    return this.records.filter((record) => record.status === "interrupted" && record.pid);
  }

  list() {
    return [...this.records].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(id) {
    const exact = this.records.find((record) => record.id === id);
    if (exact) return exact;
    const matches = this.records.filter((record) => record.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  outputTail(id) {
    return this.tails.get(id) || "";
  }

  async start(task, category) {
    if (this.shuttingDown) throw new Error("Bengacoon is shutting down; no job can start.");
    // start() awaits before the child is tracked, so counting tracked children alone lets
    // concurrent calls all pass this check before any of them registers. Reserve the slot in
    // the same tick as the check, and release it once the child is tracked or the start fails.
    if (this.children.size + this.startingJobs >= MAX_CONCURRENT_JOBS) {
      throw new Error(
        `Bengacoon allows at most ${MAX_CONCURRENT_JOBS} concurrent jobs; wait for one to finish or cancel it.`,
      );
    }
    this.startingJobs += 1;
    try {
      return await this.startReserved(task, category);
    } finally {
      this.startingJobs -= 1;
    }
  }

  async startReserved(task, category) {
    const normalizedCategory = validateJobCategory(category);
    const record = {
      id: randomUUID(),
      category: normalizedCategory,
      title: jobTitleForCategory(normalizedCategory),
      status: "queued",
      createdAt: now(),
    };
    this.records.push(record);
    this.tasks.set(record.id, task);
    await this.persist();
    this.changed();

    let child;
    try {
      const model = await this.modelForCategory?.(normalizedCategory);
      const invocation = childInvocation(task, model);
      child = this.spawnChild(
        invocation.command,
        invocation.args,
        {
          cwd: this.worktreeRoot,
          env: childEnvironment(this.profileDir, this.worktreeRoot),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // The child leads its own process group so termination can reach a
          // grandchild it spawned. The parent never calls unref(), so the child
          // is still tracked and still terminated by cancel, timeout, and shutdown.
          detached: true,
        },
      );
    } catch {
      await this.finishWithoutChild(record, "failed", "Unable to start the child Bengacoon process.");
      throw new Error("Unable to start the child Bengacoon process.");
    }

    record.status = "running";
    record.startedAt = now();
    if (Number.isInteger(child.pid) && child.pid > 0) record.pid = child.pid;
    this.trackChild(record, child);
    this.changed();
    await this.persist();

    child.stdout.on("data", (chunk) => this.capture(record, chunk));
    child.stderr.on("data", (chunk) => this.capture(record, chunk));
    child.on("error", () => {
      this.guard(this.requestStop(record, "failed", "Child Bengacoon process reported an execution error."));
    });

    const timeout = setTimeout(() => {
      if (TERMINAL_STATES.has(record.status)) return;
      this.guard(this.requestStop(record, "failed", "Job timed out."));
    }, DEFAULT_TIMEOUT_MS);
    timeout.unref?.();
    child.once("close", () => clearTimeout(timeout));

    return record;
  }

  trackChild(record, child) {
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.children.set(record.id, { child, closed });
    child.on("close", (code, signal) => {
      sweepChildGroup(child);
      this.guard(this.complete(record, code, signal).finally(resolveClosed));
    });
  }

  async cancel(id) {
    const record = this.get(id);
    if (!record) throw new Error(`Job ${id} was not found.`);
    if (TERMINAL_STATES.has(record.status)) return record;

    if (!(await this.requestStop(record, "cancelled", "Cancelled by user."))) {
      throw new Error("Child termination could not be confirmed; the job was recorded as termination_unconfirmed.");
    }
    return record;
  }

  async shutdown() {
    this.shuttingDown = true;
    const stopping = this.records
      .filter((record) => !TERMINAL_STATES.has(record.status))
      .map((record) =>
        this.requestStop(
          record,
          "interrupted",
          "Bengacoon session shut down before this job finished.",
        ),
      );
    await Promise.all(stopping);
    this.changed();
    await this.persist();
  }

  capture(record, chunk) {
    if (TERMINAL_STATES.has(record.status)) return;
    const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const appended = appendTail(this.outputTail(record.id), value);
    this.tails.set(record.id, sanitizeOutputTail(appended));
    this.changed();
  }

  async complete(record, code, signal) {
    this.children.delete(record.id);
    if (TERMINAL_STATES.has(record.status)) return;

    const requestedStop = this.stopReasons.get(record.id);
    this.stopReasons.delete(record.id);
    if (requestedStop) {
      Object.assign(record, terminalMetadata(requestedStop.status, requestedStop.error));
      if (typeof code === "number") record.exitCode = code;
    } else if (wasStoppedByGuard(this.outputTail(record.id))) {
      Object.assign(record, terminalMetadata("failed", GUARD_BLOCKED_ERROR));
      if (typeof code === "number") record.exitCode = code;
    } else if (code === 0) {
      Object.assign(record, terminalMetadata("completed"));
      record.exitCode = 0;
    } else {
      Object.assign(
        record,
        terminalMetadata("failed", "Child process stopped unsuccessfully."),
      );
      if (typeof code === "number") record.exitCode = code;
    }
    delete record.pid;
    this.changed();
    await this.persist();
    this.deliverTerminal(record);
  }

  async finishWithoutChild(record, status, error) {
    if (TERMINAL_STATES.has(record.status)) return;
    Object.assign(record, terminalMetadata(status, error));
    delete record.pid;
    this.changed();
    await this.persist();
    this.deliverTerminal(record);
  }

  async requestStop(record, status, error) {
    if (TERMINAL_STATES.has(record.status)) return true;
    if (!this.stopReasons.has(record.id)) {
      this.stopReasons.set(record.id, { status, error });
    }
    if (await this.terminateAndWait(record.id)) return true;
    await this.reportUnconfirmedTermination(record);
    return false;
  }

  async reportUnconfirmedTermination(record) {
    if (TERMINAL_STATES.has(record.status) || record.status === UNCONFIRMED_TERMINATION_STATUS) return;
    record.status = UNCONFIRMED_TERMINATION_STATUS;
    record.error = UNCONFIRMED_TERMINATION_ERROR;
    delete record.endedAt;
    delete record.exitCode;
    delete record.pid;
    this.changed();
    await this.persist();
    this.deliverTerminal(record);
  }

  async terminateAndWait(id) {
    const tracked = this.children.get(id);
    if (!tracked) return false;
    const { child, closed } = tracked;
    signalChild(child, "SIGTERM");
    if (await this.waitForClose(closed, TERMINATION_GRACE_MS)) return true;
    signalChild(child, "SIGKILL");
    return this.waitForClose(closed, TERMINATION_CONFIRM_MS);
  }

  async waitForClose(closed, timeoutMs) {
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([closed.then(() => true), timedOut]);
    clearTimeout(timer);
    return result;
  }

  deliverTerminal(record) {
    if (!DELIVERY_STATUSES.has(record.status)) return;
    const finalResult = record.status === "completed"
      ? deriveFinalResult(this.outputTail(record.id), this.tasks.get(record.id))
      : undefined;
    this.onTerminal?.({
      id: record.id,
      category: validateJobCategory(record.category),
      title: jobTitleForCategory(record.category),
      status: record.status,
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
      ...(finalResult ? { finalResult } : {}),
    });
  }

  async persist() {
    const snapshot = this.records.map((record) => ({ ...record }));
    const attempt = this.persistQueue.then(() => this.store.save(snapshot));
    this.persistQueue = attempt.catch(() => undefined);
    return attempt;
  }

  guard(promise) {
    return promise.catch((error) => {
      const detail = sanitizeFinalResult(error?.message) ?? "unknown error";
      this.onError?.(`Bengacoon background job bookkeeping failed: ${detail}`);
    });
  }

  changed() {
    this.onChange?.(this.list());
  }
}
