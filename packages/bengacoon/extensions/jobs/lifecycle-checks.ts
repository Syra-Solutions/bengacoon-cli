import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childArguments, childEnvironment, childInvocation, deriveFinalResult, formatTerminalCompletion, JobManager, sanitizeOutputTail, wasStoppedByGuard } from "./runner.ts";
import { GUARD_BLOCKED_MARKER, isGuardedPathInsideRoot } from "./child-guard.ts";
import { isSameOrDescendant, normalizeRecord, normalizeRecords, resolveProfileDir } from "./storage.ts";
import { MODEL_ASSIGNMENTS_FILE, readModelAssignments, resolveBengacoonAgentDir, resolveModelAssignment, skillTargetFromInput, writeModelAssignments } from "../models/config.ts";
import { formatDetail, statusText } from "./format.ts";
import orchestrator, { contextStoreAdapter, orchestratorPrompt } from "../orchestrator.ts";
import { parseCodexQuotaHeaders } from "../quota.ts";

class MemoryStore {
  constructor(initialRecords = []) {
    this.initialRecords = initialRecords;
    this.snapshots = [];
  }

  async load() {
    return this.initialRecords;
  }

  async save(records) {
    this.snapshots.push(JSON.parse(JSON.stringify(normalizeRecords(records))));
  }
}

class ClosingChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.closed = false;
    this.pid = 4321;
  }

  kill() {
    setTimeout(() => {
      this.closed = true;
      this.emit("close", null, "SIGTERM");
    }, 10);
    return true;
  }
}

class FlakyStore {
  constructor() {
    this.calls = 0;
    this.snapshots = [];
  }

  async load() {
    return [];
  }

  async save(records) {
    this.calls += 1;
    if (this.calls > 2) throw new Error("disk full");
    this.snapshots.push(JSON.parse(JSON.stringify(normalizeRecords(records))));
  }
}

class NonClosingChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    return true;
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

const root = await realpath(process.cwd());
assert.deepEqual(
  childArguments("inspect the repository", "openai/gpt-5.6-terra:low").slice(0, 2),
  ["--model", "openai/gpt-5.6-terra:low"],
);
assert.equal(childArguments("inspect the repository").includes("--model"), false);
assert.deepEqual(
  childInvocation("inspect the repository", undefined, "/opt/bengacoon/cli.js"),
  {
    command: process.execPath,
    args: ["/opt/bengacoon/cli.js", ...childArguments("inspect the repository")],
  },
);
assert.deepEqual(
  parseCodexQuotaHeaders({
    "x-codex-daily-used-percent": "25",
    "x-codex-weekly-remaining-percent": "40",
  }),
  { dailyRemainingPercent: 75, weeklyRemainingPercent: 40 },
);
assert.deepEqual(
  parseCodexQuotaHeaders({
    "x-codex-primary-used-percent": "10",
    "x-codex-primary-window-minutes": "1440",
    "x-codex-secondary-used-percent": "30",
    "x-codex-secondary-window-minutes": "10080",
  }),
  { dailyRemainingPercent: 90, weeklyRemainingPercent: 70 },
);
assert.equal(parseCodexQuotaHeaders({ "x-request-id": "request-1" }), undefined);
assert.equal(resolveBengacoonAgentDir({}, "/home/example"), "/home/example/.bengacoon/agent");
assert.equal(
  resolveBengacoonAgentDir({ BENGACOON_CODING_AGENT_DIR: "/custom/agent" }, "/home/example"),
  "/custom/agent",
);

const modelConfigDir = await mkdtemp(join(tmpdir(), "syra-model-assignments-"));
const supportedModelTargets = new Set(["skill:explore", "job:exploration"]);
const configuredAssignments = {
  "skill:explore": { model: "openai/gpt-5.6-terra", thinking: "medium" },
};
await writeModelAssignments(modelConfigDir, configuredAssignments, supportedModelTargets);
assert.deepEqual(
  JSON.parse(await readFile(join(modelConfigDir, MODEL_ASSIGNMENTS_FILE), "utf8")),
  { version: 1, targets: configuredAssignments },
);
assert.deepEqual(await readModelAssignments(modelConfigDir, supportedModelTargets), configuredAssignments);
assert.deepEqual(
  resolveModelAssignment(configuredAssignments, "job:exploration", {
    model: "openai/gpt-5.6-sol",
    thinking: "high",
  }),
  { model: "openai/gpt-5.6-sol", thinking: "high" },
);
assert.equal(skillTargetFromInput("/skill:explore repository history"), "skill:explore");
assert.equal(skillTargetFromInput("/skill:explore"), "skill:explore");
assert.equal(skillTargetFromInput("explore repository history"), undefined);
await assert.rejects(
  writeModelAssignments(
    modelConfigDir,
    { "skill:missing": { model: "openai/gpt-5.6-terra", thinking: "medium" } },
    supportedModelTargets,
  ),
  /Unsupported model-assignment target: skill:missing/,
);

const orchestrationHandlers = new Map();
const orchestrationCommands = new Map();
const orchestrationRenderers = new Map();
const orchestrationTools = new Map();
const selectedModels = [];
const selectedThinking = [];
orchestrator({
  on(name, handler) {
    orchestrationHandlers.set(name, handler);
  },
  registerCommand(name, command) {
    orchestrationCommands.set(name, command);
  },
  registerMessageRenderer(name, renderer) {
    orchestrationRenderers.set(name, renderer);
  },
  registerTool(tool) {
    orchestrationTools.set(tool.name, tool);
  },
  async setModel(model) {
    selectedModels.push(model);
    return true;
  },
  getThinkingLevel() {
    return "high";
  },
  setThinkingLevel(level) {
    selectedThinking.push(level);
  },
});
assert.equal(typeof orchestrationRenderers.get("bengacoon-workflow-notice"), "function");
assert.ok(orchestrationTools.has("bengacoon_report_review"));
assert.match(orchestratorPrompt(root, ["bengacoon_report_review"]), /bengacoon_report_review/);
assert.match(orchestratorPrompt(root, ["bengacoon_report_delivery"]), /bengacoon_report_delivery/);
assert.match(orchestratorPrompt(root, []), /A blocked unit reports the redacted command output/);
assert.match(orchestratorPrompt(root, ["bengacoon_report_delivery", "mem_search", "mem_save"]), /delivery\/current-work/);
const originalModel = { provider: "openai", id: "gpt-5.6-sol" };
const configuredModel = { provider: "openai", id: "gpt-5.6-terra" };
const modelContext = {
  cwd: root,
  model: originalModel,
  modelRegistry: { find: () => configuredModel },
  ui: { notify() {} },
};
const priorProfileDir = process.env.BENGACOON_CODING_AGENT_DIR;
process.env.BENGACOON_CODING_AGENT_DIR = modelConfigDir;
await orchestrationHandlers.get("input")({ text: "/skill:explore" }, modelContext);
await orchestrationHandlers.get("before_agent_start")({ systemPrompt: "base", systemPromptOptions: {} }, modelContext);
await orchestrationHandlers.get("agent_settled")({}, modelContext);
if (priorProfileDir === undefined) delete process.env.BENGACOON_CODING_AGENT_DIR;
else process.env.BENGACOON_CODING_AGENT_DIR = priorProfileDir;
assert.deepEqual(selectedModels, [configuredModel, originalModel]);
assert.deepEqual(selectedThinking, ["medium", "high"]);
const pickerProfileDir = process.env.BENGACOON_CODING_AGENT_DIR;
process.env.BENGACOON_CODING_AGENT_DIR = modelConfigDir;
const pickerSelections = ["skill:explore — openai/gpt-5.6-terra (medium)", "Clear assignment", undefined];
const pickerChoices = [];
await orchestrationCommands.get("syra-models").handler("", {
  modelRegistry: { getAvailable: () => [configuredModel] },
  ui: {
    async select(_title, choices) {
      pickerChoices.push(choices);
      return pickerSelections.shift();
    },
    notify() {},
  },
});
assert.match(pickerChoices[0].find((choice) => choice.startsWith("skill:explore")), /gpt-5\.6-terra \(medium\)/);
assert.equal(pickerChoices.length, 3);
if (pickerProfileDir === undefined) delete process.env.BENGACOON_CODING_AGENT_DIR;
else process.env.BENGACOON_CODING_AGENT_DIR = pickerProfileDir;

assert.equal(isSameOrDescendant("/home/example/.pi/agent/jobs", "/home/example/.pi/agent"), true);
assert.equal(isSameOrDescendant("/home/example/.pi/other", "/home/example/.pi/agent"), false);
assert.equal(await isGuardedPathInsideRoot(root, "extensions"), true);
assert.equal(await isGuardedPathInsideRoot(root, "/etc/passwd"), false);
// Pi expands a leading "~" inside the tool, after the guard has decided, so the literal form
// must be judged as the home directory it becomes rather than as a name inside the root.
assert.equal(await isGuardedPathInsideRoot(root, "~/.ssh/id_rsa"), false);
assert.equal(await isGuardedPathInsideRoot(root, "~"), false);
assert.equal(await isGuardedPathInsideRoot(root, "~/"), false);
// A "~user" form cannot be resolved reliably, so it is refused rather than guessed at.
assert.equal(await isGuardedPathInsideRoot(root, "~root/.ssh"), false);
assert.equal(await isGuardedPathInsideRoot(root, "~someone/x"), false);
// An ordinary in-repo path is unaffected.
assert.equal(await isGuardedPathInsideRoot(root, "extensions/jobs/runner.ts"), true);

const guardedRoot = await mkdtemp(join(tmpdir(), "bengacoon-guard-root-"));
const guardedAlias = `${guardedRoot}-alias`;
try {
	await writeFile(join(guardedRoot, "inside.txt"), "allowed\n");
	await symlink(guardedRoot, guardedAlias);
	assert.equal(await isGuardedPathInsideRoot(guardedAlias, "inside.txt"), true);
} finally {
	await rm(guardedAlias, { recursive: true, force: true });
	await rm(guardedRoot, { recursive: true, force: true });
}

// The extension refuses a profile inside the worktree too, so the invariant does not depend on
// the launcher being the only way in.
await assert.rejects(
  resolveProfileDir(root, undefined, root),
  /Refusing a Bengacoon profile inside the target worktree/,
);
await assert.rejects(
  resolveProfileDir(`${root}/extensions`, undefined, root),
  /Refusing a Bengacoon profile inside the target worktree/,
);

// The child gets what a Pi session needs to read one repository. Ambient authority to act
// elsewhere — an ssh agent socket above all — stays with the parent, so no future tool can
// inherit it. See gentle-ai#4324 for what such a socket enables once something can execute.
const childEnv = childEnvironment("/profile", "/repo", {
  PATH: "/usr/bin",
  HOME: "/home/example",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  BENGACOON_SKIP_VERSION_CHECK: "1",
  ANTHROPIC_API_KEY: "model-credential",
  SSH_AUTH_SOCK: "/tmp/ssh-agent/socket",
  SSH_AGENT_PID: "4242",
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "infrastructure-credential",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/example/gcp.json",
  GITHUB_TOKEN: "repository-credential",
  KUBECONFIG: "/home/example/.kube/config",
  DATABASE_URL: "postgres://user:pass@host/db",
});
for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "BENGACOON_SKIP_VERSION_CHECK", "ANTHROPIC_API_KEY"]) {
  assert.ok(name in childEnv, `${name} should reach the child`);
}
for (const name of [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN",
  "KUBECONFIG",
  "DATABASE_URL",
]) {
  assert.equal(name in childEnv, false, `${name} must not reach the child`);
}
assert.equal(childEnv.BENGACOON_CODING_AGENT_DIR, "/profile");
assert.equal(childEnv.BENGACOON_CHILD, "1");
assert.equal(childEnv.BENGACOON_TARGET_ROOT, "/repo");

// An unrecognised credential variable can be forwarded deliberately, so an unusual provider
// setup does not need the allowlist edited.
const optedInEnv = childEnvironment("/profile", "/repo", {
  PATH: "/usr/bin",
  SSH_AUTH_SOCK: "/tmp/ssh-agent/socket",
  CUSTOM_PROVIDER_CREDENTIAL: "value",
  BENGACOON_CHILD_ENV: "CUSTOM_PROVIDER_CREDENTIAL",
});
assert.equal(optedInEnv.CUSTOM_PROVIDER_CREDENTIAL, "value");
assert.equal("SSH_AUTH_SOCK" in optedInEnv, false, "opting one variable in must not open the rest");

// A skill that says "search the context store" without naming one leaves the model to guess
// which tools that means. The adapter is injected only when its tools are actually present, so
// an absent store is detected rather than assumed.
const adapterDir = new URL("../../orchestrator/", import.meta.url).pathname;
assert.equal(contextStoreAdapter(["read", "grep", "bash"], adapterDir), undefined);
assert.equal(contextStoreAdapter([], adapterDir), undefined);
assert.equal(contextStoreAdapter(undefined, adapterDir), undefined);
// Half the tools is not a usable store.
assert.equal(contextStoreAdapter(["mem_search"], adapterDir), undefined);
// MCP tools arrive under a host-specific prefix, so the match is on the name, not equality.
assert.match(contextStoreAdapter(["mem_search", "mem_save"], adapterDir), /Engram/);
assert.match(contextStoreAdapter(["mcp__engram__mem_search", "mcp__engram__mem_save"], adapterDir), /Engram/);

const completionId = "00000000-0000-4000-8000-000000000000";
const rawTask = "inspect the repository structure";
const derivedResult = deriveFinalResult(
  "debug log\nFINAL_RESULT: Found the background-job modules. Authorization: Bearer child-output-must-not-be-delivered\n",
  rawTask,
);
assert.equal(derivedResult?.includes("child-output-must-not-be-delivered"), false);
assert.match(derivedResult, /Found the background-job modules/);
assert.equal(deriveFinalResult(`FINAL_RESULT: ${rawTask}`, rawTask), undefined);
for (const [status, safeSummary] of [
  ["completed", "The read-only job completed."],
  ["failed", "The job did not complete."],
  ["cancelled", "The job was cancelled."],
  ["termination_unconfirmed", "Process termination could not be confirmed."],
]) {
  const completion = formatTerminalCompletion({
    id: completionId,
    category: "verification",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:02.000Z",
    task: rawTask,
    output: "Authorization: Bearer child-output-must-not-be-delivered",
    finalResult: derivedResult,
  }, Date.parse("2026-01-01T00:00:03.000Z"));
  assert.match(completion, new RegExp(`Bengacoon Repository verification job ${completionId}: ${status}`));
  assert.match(completion, /Duration: 2s\./);
  assert.ok(completion.includes(safeSummary));
  assert.match(completion, /Final result: Found the background-job modules/);
  assert.match(completion, new RegExp(`/jobs ${completionId}`));
  assert.equal(completion.includes(rawTask), false);
  assert.equal(completion.includes("child-output-must-not-be-delivered"), false);
}

const normalized = normalizeRecords([{
  id: completionId,
  category: "verification",
  title: rawTask,
  task: rawTask,
  output: "raw logs are never stored",
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
}]);
assert.deepEqual(normalized, [{
  id: completionId,
  category: "verification",
  title: "Repository verification",
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
}]);

const staleEvents = [];
const staleStore = new MemoryStore([{
  id: "11111111-1111-4111-8111-111111111111",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
}]);
const staleManager = new JobManager(
  staleStore,
  root,
  "/safe/profile",
  undefined,
  undefined,
  (record) => staleEvents.push(record),
);
await staleManager.initialize();
assert.equal(staleManager.get("11111111").status, "interrupted");
assert.deepEqual(staleEvents, []);

const completedStore = new MemoryStore();
const completedChild = new ClosingChild();
const completedEvents = [];
let completedInvocation;
const completedManager = new JobManager(
  completedStore,
  root,
  "/safe/profile",
  undefined,
  (command, args) => {
    completedInvocation = { command, args };
    return completedChild;
  },
  (record) => completedEvents.push(record),
);
await completedManager.initialize();
const completedRecord = await completedManager.start(rawTask, "verification");
assert.deepEqual(completedInvocation, childInvocation(rawTask));
assert.equal(completedRecord.pid, 4321);
completedManager.capture(completedRecord, "FINAL_RESULT: Found the background-job modules. token: child-output-must-not-be-delivered\n");
completedChild.emit("close", 0, null);
await nextTurn();
assert.equal(completedRecord.status, "completed");
assert.equal(completedRecord.pid, undefined);
assert.equal(completedStore.snapshots.at(-1)[0].title, "Repository verification");
assert.equal("pid" in completedStore.snapshots.at(-1)[0], false);
assert.equal(JSON.stringify(completedStore.snapshots).includes(rawTask), false);
assert.equal(JSON.stringify(completedStore.snapshots).includes("child-output-must-not-be-delivered"), false);
assert.equal(completedEvents.at(-1).finalResult.includes("child-output-must-not-be-delivered"), false);
assert.match(completedEvents.at(-1).finalResult, /Found the background-job modules/);

const store = new MemoryStore();
const child = new ClosingChild();
const terminalEvents = [];
const manager = new JobManager(
  store,
  root,
  "/safe/profile",
  undefined,
  () => child,
  (record) => terminalEvents.push(record),
);
await manager.initialize();
const record = await manager.start("inspect the repository structure");
manager.capture(record, "Authorization: Bearer child-output-must-not-be-persisted");
await manager.persist();
assert.equal(JSON.stringify(store.snapshots.at(-1)).includes("child-output-must-not-be-persisted"), false);
await manager.shutdown();
assert.equal(child.closed, true);
assert.equal(record.status, "interrupted");
assert.ok(record.endedAt);
assert.equal(manager.children.size, 0);
assert.deepEqual(terminalEvents.map((event) => event.status), ["interrupted"]);
assert.equal(JSON.stringify(terminalEvents).includes("child-output-must-not-be-persisted"), false);
assert.equal(JSON.stringify(terminalEvents).includes("inspect the repository structure"), false);

const unconfirmedStore = new MemoryStore();
const nonClosingChild = new NonClosingChild();
const unconfirmedEvents = [];
const cancellationManager = new JobManager(
  unconfirmedStore,
  root,
  "/safe/profile",
  undefined,
  () => nonClosingChild,
  (record) => unconfirmedEvents.push(record),
);
await cancellationManager.initialize();
const unconfirmedRecord = await cancellationManager.start("inspect cancellation handling");
cancellationManager.waitForClose = async () => false;
await assert.rejects(cancellationManager.cancel(unconfirmedRecord.id), /termination_unconfirmed/);
assert.equal(unconfirmedRecord.status, "termination_unconfirmed");
assert.equal(unconfirmedRecord.error, "Child termination could not be confirmed.");
assert.equal(unconfirmedRecord.endedAt, undefined);
assert.equal(unconfirmedStore.snapshots.at(-1)[0].status, "termination_unconfirmed");
assert.equal(unconfirmedStore.snapshots.at(-1)[0].error, "Child termination could not be confirmed.");
assert.deepEqual(unconfirmedEvents.map((event) => event.status), ["termination_unconfirmed"]);
assert.equal(normalizeRecords([{ ...unconfirmedRecord, error: "unrecognized child output" }]).length, 0);
await cancellationManager.requestStop(unconfirmedRecord, "failed", "Job timed out.");
await cancellationManager.shutdown();
nonClosingChild.emit("error", new Error("late child error"));
await nextTurn();
assert.equal(unconfirmedRecord.status, "termination_unconfirmed");

nonClosingChild.emit("close", 137, null);
await nextTurn();
assert.equal(unconfirmedRecord.status, "cancelled");
assert.equal(unconfirmedRecord.error, "Cancelled by user.");
assert.ok(unconfirmedRecord.endedAt);
assert.equal(unconfirmedRecord.exitCode, 137);
assert.equal(cancellationManager.children.size, 0);
assert.equal(unconfirmedStore.snapshots.at(-1)[0].status, "cancelled");
assert.equal(unconfirmedStore.snapshots.at(-1)[0].error, "Cancelled by user.");
assert.equal(unconfirmedStore.snapshots.at(-1)[0].exitCode, 137);
assert.deepEqual(unconfirmedEvents.map((event) => event.status), [
  "termination_unconfirmed",
  "cancelled",
]);
assert.equal(JSON.stringify(unconfirmedEvents).includes("Cancelled by user."), false);

// An empty value must not let the pattern run past the end of its line: \s matches a
// newline, so a bare "api_key=" used to swallow the whole next line of child output.
assert.equal(
  sanitizeOutputTail("line one api_key=\nSECOND LINE\nline three\n"),
  "line one api_key=\nSECOND LINE\nline three\n",
);
assert.equal(
  sanitizeOutputTail("Authorization: Bearer\nSECOND LINE\n"),
  "Authorization: Bearer\nSECOND LINE\n",
);
assert.match(sanitizeOutputTail("api_key=real-looking-secret-value\nSECOND LINE\n"), /^\[redacted credential\]\nSECOND LINE\n$/);
assert.match(sanitizeOutputTail("Authorization: Bearer real-looking-token-value\nSECOND LINE\n"), /^\[redacted credential\]\nSECOND LINE\n$/);

// Each case pairs a credential shape with the substring that must not survive. Redaction is
// best effort rather than a boundary, so this fixes the shapes already covered and states
// plainly which ones those are.
for (const [shape, input, secret] of [
  ["http url", "db: https://admin:hunter2@example.com/x", "hunter2"],
  ["postgres url", "DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod", "hunter2"],
  ["mysql url", "conn mysql://root:s3cret@10.0.0.5/main", "s3cret"],
  ["redis url with no user", "redis://:mypassword@cache:6379", "mypassword"],
  ["mongodb+srv url", "mongodb+srv://user:pass123@cluster0.mongodb.net", "pass123"],
  ["openssh private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaGtleQ==\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaGtleQ=="],
  ["rsa private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA"],
  ["private key cut off by the tail bound", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh", "MIIEvQIBADANBgkqh"],
  ["aws access key id", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["keyword inside a longer key name", "aws_secret_access_key = wJalrXUtnFEMIK7MDENG", "wJalrXUtnFEMIK7MDENG"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
  ["slack token", "xoxb-123456789012-abcdefghijklmnop", "abcdefghijklmnop"],
  ["bearer token", "Authorization: Bearer probe-fake-token-abcdefgh", "probe-fake-token-abcdefgh"],
  ["github token", "token ghp-abcdefghijklmnop", "abcdefghijklmnop"],
]) {
  const redacted = sanitizeOutputTail(input);
  assert.equal(redacted.includes(secret), false, `${shape} survived redaction: ${redacted}`);
  assert.match(redacted, /\[redacted credentials?\]/, `${shape} produced no redaction marker`);
}

// Ordinary output must survive intact: a redaction that eats real text makes the detail view
// lie about what the child did, which is its own failure.
for (const untouched of [
  "the runner keeps a token bucket in memory\n",
  "see extensions/jobs/runner.ts:120 for details\n",
  "docs at https://example.com/path\n",
  "api_key=\nSECOND LINE\n",
]) {
  assert.equal(sanitizeOutputTail(untouched), untouched, `redaction altered ordinary output: ${untouched}`);
}

const redactedTail = sanitizeOutputTail("first line\nAuthorization: Bearer child-output-must-not-be-delivered\nsecond line\n");
assert.equal(redactedTail.includes("child-output-must-not-be-delivered"), false);
assert.equal(redactedTail, "first line\n[redacted credential]\nsecond line\n");

const splitStore = new MemoryStore();
const splitChild = new ClosingChild();
const splitManager = new JobManager(
  splitStore,
  root,
  "/safe/profile",
  undefined,
  () => splitChild,
  undefined,
);
await splitManager.initialize();
const splitRecord = await splitManager.start("inspect split credential handling");
splitManager.capture(splitRecord, "Authorization: Bea");
splitManager.capture(splitRecord, "rer child-split-credential\n");
assert.equal(splitManager.outputTail(splitRecord.id).includes("child-split-credential"), false);
assert.match(splitManager.outputTail(splitRecord.id), /\[redacted credential\]/);

const flakyStore = new FlakyStore();
const flakyChild = new ClosingChild();
const flakyErrors = [];
const flakyManager = new JobManager(
  flakyStore,
  root,
  "/safe/profile",
  undefined,
  () => flakyChild,
  undefined,
  (message) => flakyErrors.push(message),
);
await flakyManager.initialize();
const flakyRecord = await flakyManager.start("inspect flaky persistence");
flakyChild.emit("close", 0, null);
await nextTurn();
await nextTurn();
assert.equal(flakyRecord.status, "completed");
assert.deepEqual(flakyErrors, ["Bengacoon background job bookkeeping failed: disk full"]);

const pidRecord = normalizeRecord({
  id: completionId,
  category: "verification",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  pid: 4242,
  orphanProcessPresent: true,
});
assert.equal(pidRecord.pid, 4242);
assert.equal("orphanProcessPresent" in pidRecord, false);
assert.equal(normalizeRecord({ ...pidRecord, pid: 0 }).pid, undefined);
assert.equal(normalizeRecord({ ...pidRecord, pid: 4_294_967_296 }).pid, undefined);

const orphanRecordId = "22222222-2222-4222-8222-222222222222";
const orphanStore = new MemoryStore([{
  id: orphanRecordId,
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  pid: process.pid,
}]);
const orphanEvents = [];
const orphanManager = new JobManager(
  orphanStore,
  root,
  "/safe/profile",
  undefined,
  undefined,
  (record) => orphanEvents.push(record),
);
await orphanManager.initialize();
const orphanRecord = orphanManager.get(orphanRecordId);
assert.equal(orphanRecord.status, "interrupted");
assert.equal(orphanRecord.pid, process.pid);
assert.equal(orphanRecord.orphanProcessPresent, true);
assert.deepEqual(orphanManager.possibleOrphans().map((record) => record.id), [orphanRecordId]);
assert.equal(orphanStore.snapshots.at(-1)[0].pid, process.pid);
assert.deepEqual(orphanEvents, []);

// Concurrent starts are the real usage: the agent issues several tool calls in one turn.
// A sequential-only check passes even when the cap is racy, because each await lets the
// previous start register its child before the next one looks at the count.
const raceStore = new MemoryStore();
const raceManager = new JobManager(
  raceStore,
  root,
  "/safe/profile",
  undefined,
  () => new ClosingChild(),
);
await raceManager.initialize();
const raceResults = await Promise.allSettled(
  Array.from({ length: 8 }, (_, index) => raceManager.start(`inspect concurrently ${index}`)),
);
assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 3);
assert.equal(raceManager.children.size, 3);
assert.equal(raceManager.startingJobs, 0);
for (const result of raceResults.filter((entry) => entry.status === "rejected")) {
  assert.match(result.reason.message, /at most 3 concurrent jobs/);
}
// A start that never took a slot leaves nothing behind in storage.
assert.equal(raceStore.snapshots.at(-1).length, 3);

const capStore = new MemoryStore();
const capChildren = [];
const capManager = new JobManager(
  capStore,
  root,
  "/safe/profile",
  undefined,
  () => {
    const child = new NonClosingChild();
    capChildren.push(child);
    return child;
  },
  undefined,
);
await capManager.initialize();
const capRecords = [];
for (let index = 0; index < 3; index += 1) {
  capRecords.push(await capManager.start(`inspect concurrency cap ${index}`));
}
assert.equal(capManager.children.size, 3);
assert.equal(capRecords.every((record) => record.status === "running"), true);
await assert.rejects(
  capManager.start("inspect concurrency cap rejected"),
  /Bengacoon allows at most 3 concurrent jobs; wait for one to finish or cancel it\./,
);
assert.equal(capManager.records.length, 3);
assert.equal(capStore.snapshots.at(-1).length, 3);
capChildren[0].emit("close", 0, null);
await nextTurn();
assert.equal(capManager.children.size, 2);
const freedRecord = await capManager.start("inspect concurrency cap freed");
assert.equal(freedRecord.status, "running");
assert.equal(capManager.children.size, 3);
assert.equal(capManager.records.length, 4);

// A running job carries a pid by design; only a pid recovered from disk is a possible orphan.
assert.equal(
  statusText([{ status: "running", pid: 4321 }]),
  "jobs: 1 active, 0 failed",
);
assert.equal(
  statusText([{ status: "interrupted", pid: 4321 }]),
  "jobs: 1 retained, 1 possible orphan",
);
assert.equal(
  statusText([{ status: "interrupted", pid: 1 }, { status: "interrupted", pid: 2 }]),
  "jobs: 2 retained, 2 possible orphans",
);
assert.equal(statusText([{ status: "completed" }]), "jobs: 1 retained");
assert.equal(
  statusText([{ status: "interrupted", pid: 4321, orphanProcessPresent: false }]),
  "jobs: 1 retained",
);

// The pid-reuse caveat must reach the operator, never a bare "still running" claim.
const orphanDetail = formatDetail({
  id: orphanRecordId,
  category: "exploration",
  status: "interrupted",
  createdAt: "2026-01-01T00:00:00.000Z",
  pid: 4321,
  orphanProcessPresent: true,
});
assert.match(orphanDetail, /pid: 4321/);
assert.match(orphanDetail, /reuses process ids/);

// A guard termination exits 0 with no output of its own; only the stderr marker separates it
// from a job that finished and simply produced no final result.
assert.equal(wasStoppedByGuard(`${GUARD_BLOCKED_MARKER}: refused`), true);
assert.equal(wasStoppedByGuard("FINAL_RESULT: all good"), false);
assert.equal(wasStoppedByGuard(undefined), false);

const guardStore = new MemoryStore();
const guardChild = new ClosingChild();
const guardEvents = [];
const guardManager = new JobManager(
  guardStore,
  root,
  "/safe/profile",
  undefined,
  () => guardChild,
  (record) => guardEvents.push(record),
);
await guardManager.initialize();
const guardRecord = await guardManager.start("inspect a path outside the worktree");
guardChild.stderr.emit("data", `${GUARD_BLOCKED_MARKER}: Bengacoon child jobs may access only paths inside their canonical target repository. Refused read of /etc/hosts\n`);
guardChild.emit("close", 0, null);
await nextTurn();
assert.equal(guardRecord.status, "failed");
assert.equal(guardRecord.error, "Child job was stopped by the repository access guard.");
assert.equal(guardRecord.exitCode, 0);
assert.equal(guardStore.snapshots.at(-1)[0].error, "Child job was stopped by the repository access guard.");
// The refused path is operator detail for the in-session view only; it never reaches disk.
assert.equal(JSON.stringify(guardStore.snapshots).includes("/etc/hosts"), false);
assert.equal(JSON.stringify(guardEvents).includes("/etc/hosts"), false);
assert.match(guardManager.outputTail(guardRecord.id), /Refused read of \/etc\/hosts/);

// Without the marker the same exit code still means completed, so the check discriminates.
const okStore = new MemoryStore();
const okChild = new ClosingChild();
const okManager = new JobManager(okStore, root, "/safe/profile", undefined, () => okChild);
await okManager.initialize();
const okRecord = await okManager.start("inspect something inside the worktree");
okChild.stdout.emit("data", "FINAL_RESULT: Nothing unusual.\n");
okChild.emit("close", 0, null);
await nextTurn();
assert.equal(okRecord.status, "completed");

console.log("background-job lifecycle checks passed");
