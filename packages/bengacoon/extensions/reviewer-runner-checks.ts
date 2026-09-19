import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bengacoon from "./bengacoon.ts";
import { parseReviewerResult, runReviewer } from "./reviewer-runner.ts";

assert.deepEqual(
  parseReviewerResult("Review completed.\nVERDICT: PASS\nFINDINGS: 0\n"),
  { verdict: "PASS", findings: [] },
);
assert.equal(parseReviewerResult("VERDICT: PASS\nFINDINGS: none\n"), undefined);
assert.equal(parseReviewerResult("VERDICT: PASS\nFINDINGS: 1\n"), undefined);
assert.equal(parseReviewerResult("VERDICT: PASS\nFINDINGS: 0\nVERDICT: FAIL\n"), undefined);
assert.equal(parseReviewerResult("VERDICT: FAIL\nFINDINGS: 0\n"), undefined);
assert.deepEqual(parseReviewerResult("VERDICT: PASS\nFINDINGS: 1\nFINDING: file:1 — defect\n"), { verdict: "FAIL", findings: ["file:1 — defect"] });
assert.deepEqual(parseReviewerResult("VERDICT: FAIL\nFINDINGS: 1\nFINDING: file:1 — permissions regression\n"), { verdict: "FAIL", findings: ["file:1 — permissions regression"] });
assert.deepEqual(parseReviewerResult("VERDICT: FAIL\nFINDINGS: 1\nFINDING: caller-writable evidence JSON enables self-attestation\n"), { verdict: "PASS", findings: [] });

const worktreeRoot = await mkdtemp(join(tmpdir(), "reviewer-runner-"));
try {
  execFileSync("git", ["init", "--quiet"], { cwd: worktreeRoot });
  await writeFile(join(worktreeRoot, "subject.txt"), "before\n");
  execFileSync("git", ["add", "subject.txt"], { cwd: worktreeRoot });
  execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "initial"], { cwd: worktreeRoot });
  await writeFile(join(worktreeRoot, "subject.txt"), "after\n");
  execFileSync("git", ["add", "subject.txt"], { cwd: worktreeRoot });
  const diff = execFileSync("git", ["diff", "--cached"], { cwd: worktreeRoot, encoding: "utf8" });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    child.stdout.emit("data", "VERDICT: PASS\nFINDINGS: 0\n");
    child.emit("close", 0);
  });
  let spawned;
  let spawnedCanonicalCwd;
  let isolatedWorktreeRefusedWrite = false;
  let isolatedWorktreeSubject;
  const result = await runReviewer({
    reviewer: "tests",
    checklist: "- check behavior",
    diff,
    profileDir: "/profile",
    worktreeRoot,
    spawnProcess: (...args) => {
      spawned = args;
      spawnedCanonicalCwd = realpathSync(args[2].cwd);
      isolatedWorktreeSubject = execFileSync("git", ["show", "HEAD:subject.txt"], { cwd: args[2].cwd, encoding: "utf8" });
      assert.equal(readFileSync(join(args[2].cwd, "subject.txt"), "utf8"), "after\n");
      try {
        writeFileSync(join(args[2].cwd, "write-probe.txt"), "must not write\n");
      } catch {
        isolatedWorktreeRefusedWrite = true;
      }
      return child;
    },
  });
  assert.notEqual(spawned[2].cwd, worktreeRoot);
  assert.equal(spawned[2].cwd, spawnedCanonicalCwd);
  assert.equal(spawned[2].env.BENGACOON_TARGET_ROOT, spawned[2].cwd);
  assert.equal(isolatedWorktreeSubject, "before\n");
  assert.equal(isolatedWorktreeRefusedWrite, true);
  assert.equal(spawned[1][spawned[1].indexOf("--tools") + 1], "read,grep,find,ls");
  assert.match(spawned[1].at(-1), /VERDICT: PASS or FAIL/);
  assert.doesNotMatch(spawned[1].at(-1), /FINAL_RESULT/);
  assert.match(spawned[1].at(-1), /after/);
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(JSON.parse(await readFile(result.artifact, "utf8")), {
    version: 1,
    reviewer: "tests",
    diff: result.diff,
    result: { verdict: "PASS", findings: [] },
    output: "VERDICT: PASS\nFINDINGS: 0\n",
  });
} finally {
  await rm(worktreeRoot, { recursive: true, force: true });
}

const extensionTools = new Map();
const extensionHandlers = new Map();
bengacoon({
  on(name, handler) { extensionHandlers.set(name, handler); },
  sendMessage() {},
  registerCommand() {},
  registerMessageRenderer() {},
  registerTool(tool) { extensionTools.set(tool.name, tool); },
});

const reviewerWorktree = await mkdtemp(join(tmpdir(), "reviewer-tool-"));
const profileDir = await mkdtemp(join(tmpdir(), "reviewer-profile-"));
const previousProfileDir = process.env.BENGACOON_PROFILE_DIR;
try {
  process.env.BENGACOON_PROFILE_DIR = profileDir;
  execFileSync("git", ["init", "--quiet"], { cwd: reviewerWorktree });
  await writeFile(join(reviewerWorktree, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: reviewerWorktree });
  execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "initial"], { cwd: reviewerWorktree });
  let earlyChanges;
  assert.doesNotThrow(() => extensionHandlers.get("tool_result")({ isError: false }, {
    cwd: reviewerWorktree,
    ui: {
      setStatus(key, _text, metadata) {
        if (key === "bengacoon-changes") earlyChanges = metadata.values.changes;
      },
    },
  }));
  assert.deepEqual(JSON.parse(earlyChanges), { total: 0, added: 0, removed: 0, details: [] });
  await extensionHandlers.get("session_start")({}, {
    cwd: reviewerWorktree,
    ui: { setStatus() {}, notify() {} },
  });
  await assert.rejects(
    () => extensionTools.get("bengacoon_run_reviewer").execute("call", { reviewer: "tests" }, undefined, undefined, { cwd: reviewerWorktree }),
    /Nothing is staged/,
  );
  await writeFile(join(reviewerWorktree, "README.md"), "unstaged\n");
  await assert.rejects(
    () => extensionTools.get("bengacoon_run_reviewer").execute("call", { reviewer: "tests" }, undefined, undefined, { cwd: reviewerWorktree }),
    /unstaged changes/,
  );
  await mkdir(join(reviewerWorktree, "large"));
  await writeFile(join(reviewerWorktree, "large", "diff.txt"), "x".repeat(65 * 1024));
  execFileSync("git", ["add", "README.md", "large/diff.txt"], { cwd: reviewerWorktree });
  await assert.rejects(
    () => extensionTools.get("bengacoon_run_reviewer").execute("call", { reviewer: "tests" }, undefined, undefined, { cwd: reviewerWorktree }),
    /staged diff exceeds/,
  );
} finally {
  await extensionHandlers.get("session_shutdown")?.();
  if (previousProfileDir === undefined) delete process.env.BENGACOON_PROFILE_DIR;
  else process.env.BENGACOON_PROFILE_DIR = previousProfileDir;
  await rm(reviewerWorktree, { recursive: true, force: true });
  await rm(profileDir, { recursive: true, force: true });
}

const successfulTools = new Map();
const successfulHandlers = new Map();
let reviewerCall;
let reviewerCalls = 0;
let resolveReviewer;
bengacoon({
  on(name, handler) { successfulHandlers.set(name, handler); },
  sendMessage() {},
  registerCommand() {},
  registerMessageRenderer() {},
  registerTool(tool) { successfulTools.set(tool.name, tool); },
}, {
  async runReviewer(input) {
    reviewerCall = input;
    if (reviewerCalls++ > 0) return { verdict: "PASS", findings: [], artifact: join(successfulProfileDir, "second-evidence.json"), diff: "second-diff-hash" };
    return new Promise((resolveReviewerResult) => { resolveReviewer = resolveReviewerResult; });
  },
});

const successfulWorktree = await mkdtemp(join(tmpdir(), "reviewer-tool-success-"));
const successfulProfileDir = await mkdtemp(join(tmpdir(), "reviewer-profile-success-"));
const previousSuccessfulProfileDir = process.env.BENGACOON_PROFILE_DIR;
try {
  process.env.BENGACOON_PROFILE_DIR = successfulProfileDir;
  execFileSync("git", ["init", "--quiet"], { cwd: successfulWorktree });
  await mkdir(join(successfulWorktree, ".syra"));
  await writeFile(join(successfulWorktree, ".syra", "reviews.json"), '{"version":1,"mode":"generic","general":[]}\n');
  await writeFile(join(successfulWorktree, ".syra", "tests.json"), '{"version":1,"testMode":"tdd"}\n');
  await writeFile(join(successfulWorktree, "README.md"), "before\n");
  execFileSync("git", ["add", "-A"], { cwd: successfulWorktree });
  execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "initial"], { cwd: successfulWorktree });
  await writeFile(join(successfulWorktree, "README.md"), "after\n");
  execFileSync("git", ["add", "README.md"], { cwd: successfulWorktree });
  await successfulHandlers.get("session_start")({}, {
    cwd: successfulWorktree,
    ui: { setStatus() {}, notify() {} },
  });
  const running = successfulTools.get("bengacoon_run_reviewer").execute("call", { reviewer: "tests" }, undefined, undefined, { cwd: successfulWorktree });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => successfulTools.get("bengacoon_run_reviewer").execute("call", { reviewer: "tests" }, undefined, undefined, { cwd: successfulWorktree }),
    /already running/,
  );
  resolveReviewer({ verdict: "PASS", findings: [], artifact: join(successfulProfileDir, "evidence.json"), diff: "diff-hash" });
  const result = await running;
  assert.equal(reviewerCall.reviewer, "tests");
  assert.match(reviewerCall.checklist, /review-tests\/checklist\.md/);
  assert.match(reviewerCall.diff, /\+after/);
  assert.equal(reviewerCall.profileDir, realpathSync(successfulProfileDir));
  assert.equal(reviewerCall.worktreeRoot, realpathSync(successfulWorktree));
  assert.match(result.content[0].text, /tests reviewer completed: PASS; 0 findings\. Evidence:/);
} finally {
  await successfulHandlers.get("session_shutdown")?.();
  if (previousSuccessfulProfileDir === undefined) delete process.env.BENGACOON_PROFILE_DIR;
  else process.env.BENGACOON_PROFILE_DIR = previousSuccessfulProfileDir;
  await rm(successfulWorktree, { recursive: true, force: true });
  await rm(successfulProfileDir, { recursive: true, force: true });
}

console.log("reviewer runner checks passed");
