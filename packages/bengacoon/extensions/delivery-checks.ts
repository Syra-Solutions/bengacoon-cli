import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import bengacoon from "./bengacoon.ts";
import { loadDeliveryState, parseActiveDeliveryWork, restoreDeliveryState, saveDeliveryState, stagedDiffHash } from "./delivery.ts";

assert.deepEqual(
  parseActiveDeliveryWork(`# Delivery observability

- [x] completed work
      done: This is complete.

- [ ] show the active delivery unit in the sidebar
      done: the sidebar renders the next work item
`),
  {
    title: "Delivery observability",
    criterion: "the sidebar renders the next work item",
    nextStep: "show the active delivery unit in the sidebar",
  },
);
assert.equal(parseActiveDeliveryWork("# No work\n\n- [x] done\n      done: done\n"), undefined);

const tools = new Map();
const handlers = new Map();
const messages = [];
bengacoon({
  on(name, handler) { handlers.set(name, handler); },
  sendMessage(message, options) { messages.push({ message, options }); },
  registerCommand() {},
  registerMessageRenderer() {},
  registerTool(tool) { tools.set(tool.name, tool); },
});
const worktree = mkdtempSync(join(tmpdir(), "bengacoon-delivery-"));
try {
  execFileSync("git", ["init", "--quiet"], { cwd: worktree });
  writeFileSync(join(worktree, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: worktree });
  execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "initial"], { cwd: worktree });
  const commitBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  mkdirSync(join(worktree, ".syra", "work"), { recursive: true });
  writeFileSync(join(worktree, ".syra", "work", "active.md"), `# Delivery observability\n\n- [ ] render the sidebar card\n      done: the active item is visible\n`);
  writeFileSync(join(worktree, "change.md"), "staged delivery change\n");
  execFileSync("git", ["add", "change.md"], { cwd: worktree });
  const diff = execFileSync("git", ["diff", "--cached"], { cwd: worktree, encoding: "utf8" });
  const receipt = execFileSync("git", ["rev-parse", "--git-path", "review-receipt.json"], { cwd: worktree, encoding: "utf8" }).trim();
  mkdirSync(dirname(join(worktree, receipt)), { recursive: true });
  writeFileSync(join(worktree, receipt), JSON.stringify({ diff: createHash("sha256").update(diff).digest("hex") }));
  const commitDiff = stagedDiffHash(worktree);
  saveDeliveryState(worktree, {
    title: "Delivery observability",
    criterion: "the active item is visible",
    nextStep: "render the sidebar card",
    state: "active",
    commitBase,
    commitDiff,
    verification: "check passed",
    receipt: "matches",
  });
  assert.deepEqual(loadDeliveryState(worktree), {
    title: "Delivery observability",
    criterion: "the active item is visible",
    nextStep: "render the sidebar card",
    state: "active",
    commitBase,
    commitDiff,
    verification: "check passed",
    receipt: "matches",
  });
  assert.deepEqual(restoreDeliveryState(worktree), {
    title: "Delivery observability",
    criterion: "the active item is visible",
    nextStep: "render the sidebar card",
    state: "active",
    commitBase,
    commitDiff,
    verification: "check passed",
    receipt: "matches",
  });
  execFileSync("git", ["reset", "--quiet"], { cwd: worktree });
  assert.equal(restoreDeliveryState(worktree).receipt, "missing");
  execFileSync("git", ["add", "change.md"], { cwd: worktree });
  const statuses = new Map();
  await tools.get("bengacoon_report_delivery").execute("call", { workFile: ".syra/work/active.md", verification: "check passed" }, undefined, undefined, {
    cwd: worktree,
    ui: { setStatus(key, _text, metadata) { statuses.set(key, metadata); } },
  });
  assert.deepEqual(JSON.parse(statuses.get("bengacoon-delivery").values.delivery), {
    title: "Delivery observability",
    criterion: "the active item is visible",
    nextStep: "render the sidebar card",
    state: "active",
    commitBase,
    commitDiff,
    verification: "check passed",
    receipt: "matches",
  });
  await tools.get("bengacoon_finish_delivery").execute("call", { state: "blocked", reason: "reviewer failed" }, undefined, undefined, {
    cwd: worktree,
    ui: { setStatus(key, _text, metadata) { statuses.set(key, metadata); } },
  });
  assert.deepEqual(loadDeliveryState(worktree), {
    title: "Delivery observability",
    criterion: "the active item is visible",
    nextStep: "reviewer failed",
    state: "blocked",
    commitBase,
    commitDiff,
    verification: "check passed",
    receipt: "matches",
  });
  await tools.get("bengacoon_report_delivery").execute("call", { workFile: ".syra/work/active.md", verification: "check passed" }, undefined, undefined, {
    cwd: worktree,
    ui: { setStatus(key, _text, metadata) { statuses.set(key, metadata); } },
  });
  await tools.get("bengacoon_finish_delivery").execute("call", { state: "awaiting-human", reason: "choose branch" }, undefined, undefined, {
    cwd: worktree,
    ui: { setStatus(key, _text, metadata) { statuses.set(key, metadata); } },
  });
  assert.deepEqual(loadDeliveryState(worktree), {
    title: "Delivery observability",
    criterion: "the active item is visible",
    nextStep: "choose branch",
    state: "awaiting-human",
    commitBase,
    commitDiff,
    verification: "check passed",
    receipt: "matches",
  });
  await tools.get("bengacoon_report_delivery").execute("call", { workFile: ".syra/work/active.md", verification: "check passed" }, undefined, undefined, {
    cwd: worktree,
    ui: { setStatus(key, _text, metadata) { statuses.set(key, metadata); } },
  });
  handlers.get("agent_end")({}, { cwd: worktree, ui: { setStatus() {} } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].options.triggerTurn, false);
  writeFileSync(join(worktree, "unrelated.md"), "unrelated commit\n");
  execFileSync("git", ["add", "unrelated.md"], { cwd: worktree });
  execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "--only", "unrelated.md", "-m", "unrelated"], { cwd: worktree });
  handlers.get("agent_end")({}, { cwd: worktree, ui: { setStatus() {} } });
  assert.equal(loadDeliveryState(worktree).state, "active");
  execFileSync("git", ["add", "change.md"], { cwd: worktree });
  execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "delivery after unrelated"], { cwd: worktree });
  handlers.get("agent_end")({}, { cwd: worktree, ui: { setStatus() {} } });
  assert.equal(loadDeliveryState(worktree).state, "active");
  writeFileSync(join(worktree, "change-2.md"), "new work unit\n");
  execFileSync("git", ["add", "change-2.md"], { cwd: worktree });
  await tools.get("bengacoon_report_delivery").execute("call", { workFile: ".syra/work/active.md", verification: "check passed" }, undefined, undefined, {
    cwd: worktree,
    ui: { setStatus(key, _text, metadata) { statuses.set(key, metadata); } },
  });
  execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "delivery"], { cwd: worktree });
  handlers.get("agent_end")({}, { cwd: worktree, ui: { setStatus() {} } });
  assert.equal(loadDeliveryState(worktree).state, "committed");
} finally {
  rmSync(worktree, { recursive: true, force: true });
}

console.log("delivery checks passed");
