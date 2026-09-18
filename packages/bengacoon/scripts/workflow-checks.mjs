// The workflow's guarantees live in two scripts and eight instruction files, and until now
// nothing checked either. prove-red and review-gate were verified by hand in throwaway
// repositories, and those runs are gone. A skill with broken frontmatter passed every check
// while the agent silently never loaded it — the same shape as a shell check reporting success
// on a launcher that could not start.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import orchestrator, { hookNotice, orchestratorPrompt } from "../extensions/orchestrator.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const proveRed = join(repoRoot, "scripts", "prove-red.mjs");
const reviewGate = join(repoRoot, "scripts", "review-gate.mjs");
const proveCovered = join(repoRoot, "scripts", "prove-covered.mjs");

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A repository with one failing check, so the fix and the check are both real.
function writeTestMode(dir, testMode) {
  mkdirSync(join(dir, ".syra"), { recursive: true });
  writeFileSync(join(dir, ".syra", "tests.json"), `${JSON.stringify({ version: 1, testMode })}\n`);
}

function scratchRepo({ budgetLines, testMode = "tdd" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-checks-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  writeFileSync(join(dir, "sum.mjs"), "export const total = (xs) => xs.reduce((a, b) => a + b, 1);\n");
  writeFileSync(
    join(dir, "sum.test.mjs"),
    'import assert from "node:assert/strict";\nimport { total } from "./sum.mjs";\nassert.equal(total([1, 2, 3]), 6);\n',
  );
  writeFileSync(join(dir, "package.json"), '{"name":"t","scripts":{"test":"node sum.test.mjs"}}\n');
  mkdirSync(join(dir, ".syra"), { recursive: true });
  writeFileSync(
    join(dir, ".syra", "reviews.json"),
    `${JSON.stringify({ version: 1, mode: "generic", general: [], ...(budgetLines ? { budgetLines } : {}) })}\n`,
  );
  writeTestMode(dir, testMode);
  git(["init", "-q", "."]);
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial"]);
  return { dir, git };
}

function applyFix(dir) {
  writeFileSync(join(dir, "sum.mjs"), "export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n");
}

console.log("prove-red");
{
  const { dir } = scratchRepo();
  applyFix(dir);
  const proven = run(proveRed, ["--check", "npm test", "--change", "sum.mjs"], dir);
  assert.equal(proven.status, 0, `a real fix should prove red:\n${proven.output}`);
  assert.match(proven.output, /without the change: FAIL/);
  // The fix must be back exactly as it was, or the tool costs more than it proves.
  assert.match(readFileSync(join(dir, "sum.mjs"), "utf8"), /a \+ b, 0/);
  console.log("  a real fix proves red, and the change is restored");
  rmSync(dir, { recursive: true, force: true });
}
{
  // prove-red is a workflow guarantee, and this suite already supplies its isolated Git fixture.
  // A separate runner would duplicate that fixture without testing a different layer.
  const { dir } = scratchRepo();
  const added = join(dir, "added.mjs");
  writeFileSync(added, "export const added = 4;\n");
  writeFileSync(
    join(dir, "sum.test.mjs"),
    'import assert from "node:assert/strict";\nimport { added } from "./added.mjs";\nimport { total } from "./sum.mjs";\nassert.equal(total([1, 2, 3]) + added, 11);\n',
  );
  const proven = run(proveRed, ["--check", "npm test", "--change", "added.mjs"], dir);
  assert.equal(proven.status, 0, `an added file should prove red:\n${proven.output}`);
  assert.match(proven.output, /without the change: FAIL/);
  assert.equal(readFileSync(added, "utf8"), "export const added = 4;\n");
  console.log("  an added file proves red and is restored");
  rmSync(dir, { recursive: true, force: true });
}
{
  const { dir } = scratchRepo();
  const result = run(proveRed, ["--check", "npm test", "--change", "../outside.mjs"], dir);
  assert.equal(result.status, 2, `an outside path must be refused:\n${result.output}`);
  assert.match(result.output, /must be inside the current worktree/);
  console.log("  an outside changed path is refused before it can be touched");
  rmSync(dir, { recursive: true, force: true });
}
{
  const { dir } = scratchRepo();
  const externalDir = mkdtempSync(join(tmpdir(), "prove-red-external-"));
  const externalFile = join(externalDir, "added.mjs");
  writeFileSync(externalFile, "export const outside = true;\n");
  symlinkSync(externalDir, join(dir, "linked"));
  const result = run(proveRed, ["--check", "node -e \"\"", "--change", "linked/added.mjs"], dir);
  assert.equal(result.status, 2, `a symlink escape must be refused:\n${result.output}`);
  assert.match(result.output, /must be inside the current worktree/);
  assert.equal(readFileSync(externalFile, "utf8"), "export const outside = true;\n");
  console.log("  a changed path through a worktree symlink is refused before it can be touched");
  rmSync(dir, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
}
{
  // A check that asserts something the change does not affect stays green without it. That is
  // the case worth catching: two green things that are not connected.
  const { dir } = scratchRepo();
  writeFileSync(
    join(dir, "sum.test.mjs"),
    'import assert from "node:assert/strict";\nimport { total } from "./sum.mjs";\nassert.equal(typeof total, "function");\n',
  );
  applyFix(dir);
  const result = run(proveRed, ["--check", "npm test", "--change", "sum.mjs"], dir);
  assert.equal(result.status, 1, `a check that does not verify the change must be reported:\n${result.output}`);
  assert.match(result.output, /not verifying the change/);
  console.log("  a check that passes without the change is reported, not accepted");
  rmSync(dir, { recursive: true, force: true });
}
{
  // Never green with the change in place means step 3 never happened, so step 4 cannot mean
  // anything. It has to refuse rather than report a red it did not cause.
  const { dir } = scratchRepo();
  const result = run(proveRed, ["--check", "npm test", "--change", "sum.mjs"], dir);
  assert.equal(result.status, 2, `an unfixed check must stop the step:\n${result.output}`);
  assert.match(result.output, /does not pass with the change/);
  console.log("  a check that was never green stops the step");
  rmSync(dir, { recursive: true, force: true });
}
{
  // Unrelated uncommitted work is never the cost of running this.
  const { dir } = scratchRepo();
  const untouched = join(dir, "SCRATCH.md");
  writeFileSync(untouched, "notes nobody committed\n");
  applyFix(dir);
  const snapshotsBefore = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("prove-red-")));
  run(proveRed, ["--check", "npm test", "--change", "sum.mjs"], dir);
  assert.equal(readFileSync(untouched, "utf8"), "notes nobody committed\n");
  const snapshotsAfter = readdirSync(tmpdir()).filter((entry) => entry.startsWith("prove-red-") && !snapshotsBefore.has(entry));
  assert.deepEqual(snapshotsAfter, []);
  console.log("  unrelated uncommitted work is untouched, and no snapshot is left behind");
  rmSync(dir, { recursive: true, force: true });
}

console.log("prove-covered");
{
  const GOOD = "export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n";
  const BROKEN = "export const total = (xs) => xs.reduce((a, b) => a + b, 1);\n";
  // A repository whose checks pass, which is where a refactor starts.
  const greenRepo = (options) => {
    const { dir, git } = scratchRepo(options);
    applyFix(dir);
    git(["add", "-A"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "green"]);
    return { dir, git };
  };
  // A patch made from the repository it will be applied to, the way a refactor's author makes one.
  const breakPatch = (dir) => {
    writeFileSync(join(dir, "sum.mjs"), BROKEN);
    const patch = execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" });
    writeFileSync(join(dir, "sum.mjs"), GOOD);
    const path = join(dir, "break.patch");
    writeFileSync(path, patch);
    return path;
  };

  {
    const { dir } = greenRepo();
    const patch = breakPatch(dir);
    // Only what this run leaves behind: a snapshot kept by an earlier run is deliberate, and a
    // check that fails because of one fails for a reason that has nothing to do with the change.
    const snapshotsBefore = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("prove-covered-")));
    const covered = run(proveCovered, ["--check", "npm test", "--break", patch], dir);
    assert.equal(covered.status, 0, `a covered refactor must be proven covered:\n${covered.output}`);
    assert.match(covered.output, /with it broken:     FAIL/);
    // The break must not survive: it is worse than a refactor that never happened.
    assert.equal(readFileSync(join(dir, "sum.mjs"), "utf8"), GOOD);
    const left = readdirSync(tmpdir()).filter((entry) => entry.startsWith("prove-covered-") && !snapshotsBefore.has(entry));
    assert.deepEqual(left, [], "a run that restored the tree must take its snapshot with it");
    console.log("  a break the checks notice proves the code is covered, and the break is undone");
    rmSync(dir, { recursive: true, force: true });
  }
  {
    // The case the whole route exists for: green before, green after, and no safety net at all.
    const { dir, git } = greenRepo();
    writeFileSync(
      join(dir, "sum.test.mjs"),
      'import assert from "node:assert/strict";\nimport { total } from "./sum.mjs";\nassert.equal(typeof total, "function");\n',
    );
    git(["add", "-A"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "shallow check"]);
    const result = run(proveCovered, ["--check", "npm test", "--break", breakPatch(dir)], dir);
    assert.equal(result.status, 1, `an uncovered refactor must be refused:\n${result.output}`);
    assert.match(result.output, /Nothing went red/);
    assert.equal(readFileSync(join(dir, "sum.mjs"), "utf8"), GOOD);
    console.log("  a break nothing notices is reported as no safety net, not as a pass");
    rmSync(dir, { recursive: true, force: true });
  }
  {
    // Red before the break means the red after it says nothing.
    const { dir } = greenRepo();
    const patch = breakPatch(dir);
    writeFileSync(join(dir, "sum.mjs"), BROKEN);
    const result = run(proveCovered, ["--check", "npm test", "--break", patch], dir);
    assert.equal(result.status, 2, `a failing check must stop the step:\n${result.output}`);
    assert.match(result.output, /does not pass on the code as it stands/);
    console.log("  a check that is already failing stops the step");
    rmSync(dir, { recursive: true, force: true });
  }
  {
    // A break that adds a file is the shape that got away: the file did not exist when the
    // snapshot was taken, so nothing restored it and it stayed in the tree after "restored".
    const { dir, git } = greenRepo();
    writeFileSync(join(dir, "sum.mjs"), BROKEN);
    writeFileSync(join(dir, "extracted.mjs"), "export const helper = () => 1;\n");
    git(["add", "-N", "extracted.mjs"]);
    const patch = join(dir, "adds.patch");
    writeFileSync(patch, execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" }));
    writeFileSync(join(dir, "sum.mjs"), GOOD);
    rmSync(join(dir, "extracted.mjs"));
    git(["rm", "-q", "--cached", "extracted.mjs"]);

    const result = run(proveCovered, ["--check", "npm test", "--break", patch], dir);
    assert.equal(result.status, 0, `a break that also adds a file is still a break:\n${result.output}`);
    assert.equal(readFileSync(join(dir, "sum.mjs"), "utf8"), GOOD);
    assert.equal(existsSync(join(dir, "extracted.mjs")), false, "a file the break added must be removed again");
    console.log("  a break that adds a file is undone, not left behind");
    rmSync(dir, { recursive: true, force: true });
  }
  {
    // "The patch does not apply" must never read as "you have no safety net": one is a finding
    // about the project's checks, the other is a mistake in the patch.
    const { dir } = greenRepo();
    writeFileSync(
      join(dir, "stale.patch"),
      "--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const total = (xs) => xs.reduce((a, b) => a + b, 9);\n+export const total = (xs) => xs.reduce((a, b) => a + b, 1);\n",
    );
    const result = run(proveCovered, ["--check", "npm test", "--break", join(dir, "stale.patch")], dir);
    assert.equal(result.status, 2, `a patch that will not apply must not be reported as no coverage:\n${result.output}`);
    assert.doesNotMatch(result.output, /Nothing went red/);
    assert.equal(readFileSync(join(dir, "sum.mjs"), "utf8"), GOOD);
    console.log("  a patch that will not apply is could-not-attempt, not no-safety-net");
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const { dir } = greenRepo();
    const untouched = join(dir, "SCRATCH.md");
    writeFileSync(untouched, "notes nobody committed\n");
    writeFileSync(join(dir, "nonsense.patch"), "--- a/absent.mjs\n+++ b/absent.mjs\n@@ -1 +1 @@\n-one\n+two\n");
    const result = run(proveCovered, ["--check", "npm test", "--break", join(dir, "nonsense.patch")], dir);
    assert.equal(result.status, 2, "a patch that does not apply must be refused before anything runs");
    assert.equal(readFileSync(untouched, "utf8"), "notes nobody committed\n");
    console.log("  a patch that does not apply is refused, and unrelated work is untouched");
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("review-gate");
{
  const { dir, git } = scratchRepo();
  applyFix(dir);
  git(["add", "sum.mjs"]);

  const recorded = run(reviewGate, ["record", "--route", "reproduce", "--verdict", "tests=clean"], dir);
  assert.equal(recorded.status, 0, recorded.output);
  assert.equal(run(reviewGate, ["verify"], dir).status, 0);
  console.log("  a receipt matching the staged diff verifies");

  // Reviewing, then staging more, then committing is the hole the binding closes.
  writeFileSync(join(dir, "extra.txt"), "staged after the review\n");
  git(["add", "extra.txt"]);
  const stale = run(reviewGate, ["verify"], dir);
  assert.equal(stale.status, 1, "a receipt from before the last staging must not verify");
  assert.match(stale.output, /does not match what is staged/);
  console.log("  a receipt recorded against different content is refused");
  rmSync(dir, { recursive: true, force: true });
}
{
  const { dir, git } = scratchRepo();
  applyFix(dir);
  git(["add", "sum.mjs"]);
  const never = run(reviewGate, ["verify"], dir);
  assert.equal(never.status, 1, "committing with no review at all must be refused");
  assert.match(never.output, /No review receipt/);
  console.log("  no receipt at all is refused");
  rmSync(dir, { recursive: true, force: true });
}
{
  // A chosen reviewer must not be skipped on the grounds that it probably did not apply.
  const dir = mkdtempSync(join(tmpdir(), "workflow-checks-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  mkdirSync(join(dir, ".syra"), { recursive: true });
  writeFileSync(join(dir, ".syra", "reviews.json"), '{"version":1,"mode":"generic","general":["security"]}\n');
  writeTestMode(dir, "tdd");
  writeFileSync(join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "two\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });

  const missing = run(reviewGate, ["record", "--route", "reproduce", "--verdict", "tests=clean"], dir);
  assert.equal(missing.status, 1, "a chosen reviewer with no verdict must block the receipt");
  assert.match(missing.output, /No verdict for: security/);

  const withReason = run(
    reviewGate,
    ["record", "--route", "reproduce", "--verdict", "tests=clean", "--verdict", "security=not applicable: no auth surface"],
    dir,
  );
  assert.equal(withReason.status, 0, withReason.output);
  console.log('  every selected reviewer needs a verdict, and "not applicable" counts as one');
  rmSync(dir, { recursive: true, force: true });
}
{
  const { dir, git } = scratchRepo({ budgetLines: 5 });
  writeFileSync(join(dir, "big.txt"), `${Array.from({ length: 40 }, (_, index) => index).join("\n")}\n`);
  git(["add", "big.txt"]);

  const refused = run(reviewGate, ["record", "--route", "none", "--verdict", "tests=clean"], dir);
  assert.equal(refused.status, 1, "a commit past the budget must not be recorded silently");
  assert.match(refused.output, /against a budget of 5/);
  assert.match(refused.output, /deleting comments, tests or documentation/);

  const accepted = run(
    reviewGate,
    ["record", "--route", "none", "--verdict", "tests=clean", "--oversize-accepted", "generated fixture"],
    dir,
  );
  assert.equal(accepted.status, 0, accepted.output);
  const receipt = JSON.parse(readFileSync(join(dir, ".git", "review-receipt.json"), "utf8"));
  assert.equal(receipt.oversizeAccepted, "generated fixture");
  assert.ok(receipt.lines > 5);
  console.log("  past the budget is refused, and an accepted overage is recorded with its reason");
  rmSync(dir, { recursive: true, force: true });
}
{
  // Writing tests is the project's choice; reviewing them once they are written is not.
  for (const testMode of ["tdd", "tad"]) {
    const { dir, git } = scratchRepo({ testMode });
    applyFix(dir);
    git(["add", "sum.mjs"]);
    const unreviewed = run(reviewGate, ["record", "--route", "specify"], dir);
    assert.equal(unreviewed.status, 1, `${testMode}: a project that writes tests must have them reviewed`);
    assert.match(unreviewed.output, /No verdict for: tests/);
    const reviewed = run(reviewGate, ["record", "--route", "specify", "--verdict", "tests=clean"], dir);
    assert.equal(reviewed.status, 0, reviewed.output);
    assert.equal(JSON.parse(readFileSync(join(dir, ".git", "review-receipt.json"), "utf8")).testMode, testMode);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  in tdd and tad the tests reviewer is required, and the receipt records the mode");

  {
    const { dir, git } = scratchRepo({ testMode: "none" });
    assert.match(run(reviewGate, ["plan", "--route", "reproduce"], dir).output, /^required: none/m);
    applyFix(dir);
    git(["add", "sum.mjs"]);
    const recorded = run(reviewGate, ["record", "--route", "reproduce"], dir);
    assert.equal(recorded.status, 0, `none: no tests reviewer is required:\n${recorded.output}`);
    // A commit without tests is allowed, and visible.
    assert.equal(JSON.parse(readFileSync(join(dir, ".git", "review-receipt.json"), "utf8")).testMode, "none");
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  in none nothing asks for a tests review, and the receipt still says none");

  {
    const { dir } = scratchRepo();
    rmSync(join(dir, ".syra", "tests.json"));
    const asked = run(reviewGate, ["plan", "--route", "reproduce"], dir);
    assert.equal(asked.status, 3, "a project that never said whether it writes tests must be asked");
    assert.match(asked.output, /testMode: tdd \| tad \| none/);
    writeFileSync(join(dir, ".syra", "tests.json"), '{"version":1,"testMode":""}\n');
    const blank = run(reviewGate, ["plan", "--route", "reproduce"], dir);
    assert.equal(blank.status, 2, "an empty test mode must be refused, not read as none");
    assert.match(blank.output, /"testMode" must be one of tdd, tad, none/);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  a missing test mode is asked for, and an empty one is refused rather than read as none");
}

{
  // A project's checklist replaces the generic one; the two are never both in play. The reviewer
  // reads whatever path this prints, so this is where "no overlap" is actually guaranteed.
  const dir = mkdtempSync(join(tmpdir(), "workflow-checks-"));
  const setMode = (mode) => {
    mkdirSync(join(dir, ".syra"), { recursive: true });
    writeFileSync(join(dir, ".syra", "reviews.json"), `${JSON.stringify({ version: 1, mode, general: [] })}\n`);
  };
  const resolve = (reviewer, layer) =>
    run(reviewGate, ["checklist", "--reviewer", reviewer, ...(layer ? ["--layer", layer] : [])], dir);
  const generic = (reviewer, file) => join(repoRoot, "skills", `review-${reviewer}`, file);

  // Generic mode: one checklist for the whole change, and a layer is refused rather than ignored.
  setMode("generic");
  assert.equal(resolve("code").output.trim(), generic("code", "checklist.md"));
  const layered = resolve("code", "backend");
  assert.equal(layered.status, 2, "a layer in generic mode must be refused, or a reviewer could pick a web checklist");
  mkdirSync(join(dir, ".syra", "review-context"), { recursive: true });
  writeFileSync(join(dir, ".syra", "review-context", "code.md"), "# Our code review\n\n- our rule\n");
  assert.equal(resolve("code").output.trim(), join(".syra", "review-context", "code.md"));
  console.log("  generic mode resolves one checklist for the whole change, the project's when it has one");

  // Web mode: a layer is required, and the whole-change project file does not stand in for it.
  setMode("web");
  const unlayered = resolve("code");
  assert.equal(unlayered.status, 2, "web mode without a layer must be refused");
  assert.match(unlayered.output, /backend, frontend/, "the refusal must name the layers, since reviewers follow it");
  console.log("  web mode refuses a missing layer and names the layers it needs");

  // The mode is the project's decision. Without it nothing is guessed.
  writeFileSync(join(dir, ".syra", "reviews.json"), '{"version":1,"general":[]}\n');
  const modeless = resolve("code");
  assert.equal(modeless.status, 2, "a reviews file with no mode must be refused");
  assert.match(modeless.output, /"mode" must be one of web, generic/);
  setMode("web");
  console.log("  a project with no mode is refused rather than guessed at");

  const before = resolve("code", "backend");
  assert.equal(before.status, 0, before.output);
  assert.equal(before.output.trim(), generic("code", "backend.md"));
  assert.equal(resolve("security", "frontend").output.trim(), generic("security", "checklist.md"));

  mkdirSync(join(dir, ".syra", "review-context"), { recursive: true });
  writeFileSync(join(dir, ".syra", "review-context", "code-backend.md"), "# Our code review\n\n- our rule\n");
  const replaced = resolve("code", "backend");
  assert.equal(replaced.status, 0, replaced.output);
  // One line, one path: the project file and nothing that would let the generic one back in.
  assert.equal(replaced.output.trim(), join(".syra", "review-context", "code-backend.md"));
  assert.equal(replaced.output.trim().split("\n").length, 1);
  console.log("  a project checklist replaces the generic one, and only the project one is returned");

  // Replacement is per layer: writing the backend checklist says nothing about the frontend.
  assert.equal(resolve("code", "frontend").output.trim(), generic("code", "frontend.md"));
  console.log("  replacement is per layer, so a layer the project did not write stays generic");

  writeFileSync(join(dir, ".syra", "review-context", "code-backend.md"), "  \n");
  const empty = resolve("code", "backend");
  assert.equal(empty.status, 1, "an empty project checklist would make every review against it clean");
  assert.match(empty.output, /is empty/);
  assert.equal(resolve("code", "sideways").status, 2);
  console.log("  an empty project checklist is refused rather than reviewed against");
  rmSync(dir, { recursive: true, force: true });
}

console.log("pre-commit hook");
{
  // Real commits, through git, so what is verified is that git refuses — not that `verify` would
  // have refused had someone called it.
  const commit = (dir, message) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd: dir, encoding: "utf8" });
  const hookOf = (dir) => join(dir, ".git", "hooks", "pre-commit");

  // A repository that never opted into review gets no hook: a globally installed package would
  // otherwise block commits in every repository its user opens.
  {
    const dir = mkdtempSync(join(tmpdir(), "workflow-checks-"));
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const inactive = run(reviewGate, ["install-hook"], dir);
    assert.match(inactive.output, /^inactive/);
    assert.equal(existsSync(hookOf(dir)), false, "a project with no .syra/reviews.json must not get a hook");
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  a project that has not opted into review gets no hook");

  {
    const { dir, git } = scratchRepo();
    const installed = run(reviewGate, ["install-hook"], dir);
    assert.match(installed.output, /^installed/, installed.output);
    // git silently ignores a hook that is not executable, so this is the difference between enforced and not.
    assert.ok(statSync(hookOf(dir)).mode & 0o100, "the hook must be executable, or git skips it without a word");

    applyFix(dir);
    git(["add", "sum.mjs"]);
    const unreviewed = commit(dir, "unreviewed");
    assert.notEqual(unreviewed.status, 0, "git must refuse a commit with no review receipt");
    assert.match(unreviewed.stderr, /No review receipt/);

    assert.equal(run(reviewGate, ["record", "--route", "reproduce", "--verdict", "tests=clean"], dir).status, 0);
    writeFileSync(join(dir, "extra.txt"), "staged after the review\n");
    git(["add", "extra.txt"]);
    const stale = commit(dir, "stale");
    assert.notEqual(stale.status, 0, "git must refuse a commit whose staged content changed after review");
    assert.match(stale.stderr, /does not match what is staged/);

    assert.equal(run(reviewGate, ["record", "--route", "reproduce", "--verdict", "tests=clean"], dir).status, 0);
    const reviewed = commit(dir, "reviewed");
    assert.equal(reviewed.status, 0, `a reviewed commit must go through:\n${reviewed.stderr}`);
    console.log("  git refuses an unreviewed commit and one changed after review, and accepts a reviewed one");

    assert.match(run(reviewGate, ["install-hook"], dir).output, /^current/);
    console.log("  installing again over its own hook changes nothing");
    rmSync(dir, { recursive: true, force: true });
  }

  {
    // Someone else's hook is theirs. Overwriting it would silently remove whatever it enforced.
    const { dir } = scratchRepo();
    const foreign = "#!/bin/sh\necho their own checks\n";
    mkdirSync(dirname(hookOf(dir)), { recursive: true });
    writeFileSync(hookOf(dir), foreign, { mode: 0o755 });
    const skipped = run(reviewGate, ["install-hook"], dir);
    assert.match(skipped.output, /^skipped/);
    assert.match(skipped.output, /verify \|\| exit 1/, "a skip must say how to enforce the gate by hand");
    assert.equal(readFileSync(hookOf(dir), "utf8"), foreign);
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const { dir, git } = scratchRepo();
    git(["config", "core.hooksPath", ".husky"]);
    const skipped = run(reviewGate, ["install-hook"], dir);
    assert.match(skipped.output, /^skipped/);
    assert.equal(existsSync(join(dir, ".husky", "pre-commit")), false, "a managed hooks directory must not be written to");
    assert.equal(existsSync(hookOf(dir)), false);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  a hook it did not write, or a hooks directory managed elsewhere, is left alone and reported");

  {
    // The hook points at the package. If the package goes away the commit is refused with a way
    // out, rather than passing unchecked.
    const { dir, git } = scratchRepo();
    const moved = mkdtempSync(join(tmpdir(), "workflow-checks-"));
    const copy = join(moved, "review-gate.mjs");
    writeFileSync(copy, readFileSync(reviewGate));
    assert.match(run(copy, ["install-hook"], dir).output, /^installed/);
    rmSync(moved, { recursive: true, force: true });
    applyFix(dir);
    git(["add", "sum.mjs"]);
    const orphaned = commit(dir, "orphaned");
    assert.notEqual(orphaned.status, 0, "a hook whose gate is gone must refuse, not pass");
    assert.match(orphaned.stderr, /no longer exists/);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  a hook whose gate no longer exists refuses the commit and says how to recover");

  {
    // In a worktree `.git` is a file. The receipt has to land where git keeps that worktree's state.
    const { dir } = scratchRepo();
    const tree = join(mkdtempSync(join(tmpdir(), "workflow-checks-")), "wt");
    execFileSync("git", ["worktree", "add", "-q", tree], { cwd: dir });
    applyFix(tree);
    execFileSync("git", ["add", "sum.mjs"], { cwd: tree });
    const recorded = run(reviewGate, ["record", "--route", "reproduce", "--verdict", "tests=clean"], tree);
    assert.equal(recorded.status, 0, recorded.output);
    assert.equal(run(reviewGate, ["verify"], tree).status, 0);
    rmSync(dirname(tree), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("  a receipt recorded in a worktree verifies there");

  // What a session start tells the user. Silence where nothing needs attention is the point.
  assert.equal(hookNotice("installed\n.git/hooks/pre-commit now refuses").type, "info");
  assert.equal(hookNotice("skipped\ncore.hooksPath is set").type, "warning");
  assert.equal(hookNotice("current"), undefined);
  assert.equal(hookNotice("inactive\nNo .syra/reviews.json"), undefined);
  console.log("  a session is told when the hook is installed or not enforced, and nothing otherwise");
}

console.log("installed into another project");
{
  // The skills run in a project that installed this package, where `scripts/` does not exist. Every
  // check above runs the scripts by their path in this repository, so none of them could see that.
  const { dir } = scratchRepo();
  const inShell = (command, env) => spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8", env });

  // The shape the skills used to have fails there — this is the defect, reproduced.
  const relative = inShell("node scripts/review-gate.mjs plan --route reproduce", process.env);
  assert.notEqual(relative.status, 0, "a relative script path must not resolve in another project");

  // Loading the extension is all an installed project gets. After it, the commands in the skills run as written.
  const previous = process.env.SYRA_SCRIPTS;
  delete process.env.SYRA_SCRIPTS;
  orchestrator({ on() {}, registerCommand() {} });
  assert.equal(
    process.env.SYRA_SCRIPTS,
    join(repoRoot, "scripts"),
    "loading the extension must set $SYRA_SCRIPTS, or no skill command resolves outside this repository",
  );
  const planned = inShell('node "$SYRA_SCRIPTS"/review-gate.mjs plan --route reproduce', process.env);
  assert.equal(planned.status, 0, `the gate must run from another project:\n${planned.stderr}`);
  assert.match(planned.stdout, /^route:\s+reproduce/m);
  if (previous === undefined) delete process.env.SYRA_SCRIPTS;
  else process.env.SYRA_SCRIPTS = previous;
  console.log("  after the extension loads, the skills' commands run in a project with no scripts/ of its own");

  // The agent is told what the variable is, with the path, in case a runtime does not pass it through.
  const prompt = orchestratorPrompt(dir, [], undefined, "/opt/syra/scripts");
  assert.match(prompt, /\$SYRA_SCRIPTS is "\/opt\/syra\/scripts"/);
  console.log("  the system prompt names $SYRA_SCRIPTS and where it points");
  rmSync(dir, { recursive: true, force: true });
}
{
  // Every script an instruction runs is named through $SYRA_SCRIPTS and exists. A relative path
  // works here and nowhere else, which is how it went unnoticed.
  const instructionFiles = [
    ...readdirSync(join(repoRoot, "skills"), { recursive: true }).filter((file) => file.endsWith(".md")).map((file) => join("skills", file)),
    ...readdirSync(join(repoRoot, "prompts")).filter((file) => file.endsWith(".md")).map((file) => join("prompts", file)),
    ...readdirSync(join(repoRoot, "orchestrator"), { recursive: true }).filter((file) => file.endsWith(".md")).map((file) => join("orchestrator", file)),
  ];
  let invocations = 0;
  for (const relative of instructionFiles) {
    const text = readFileSync(join(repoRoot, relative), "utf8");
    assert.doesNotMatch(text, /\bnode\s+\.?\/?scripts\//, `${relative}: runs a script by a path that only exists in this repository`);
    for (const [, script] of text.matchAll(/"\$SYRA_SCRIPTS"\/([\w.-]+)/g)) {
      assert.ok(existsSync(join(repoRoot, "scripts", script)), `${relative}: runs $SYRA_SCRIPTS/${script}, which does not exist`);
      invocations += 1;
    }
  }
  assert.ok(invocations > 0, "no instruction runs a script, so this check proved nothing");
  console.log(`  ${invocations} script invocations in instructions go through $SYRA_SCRIPTS and exist`);
}

console.log("skills and prompts");
{
  // Pi discovers a skill by its frontmatter. One that is malformed is not reported — it simply
  // never loads, and every check stays green while the workflow quietly has a hole in it.
  const skillsDir = join(repoRoot, "skills");
  const found = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(found.length > 0, "no skills found");

  for (const entry of found) {
    const path = join(skillsDir, entry.name, "SKILL.md");
    const text = readFileSync(path, "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${entry.name}: no frontmatter block`);

    const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(name, `${entry.name}: no name`);
    assert.ok(description, `${entry.name}: no description`);
    // Pi's rules: 1-64 chars, lowercase letters, digits and single inner hyphens.
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${entry.name}: name "${name}" is not a valid skill name`);
    assert.ok(name.length <= 64, `${entry.name}: name longer than 64 characters`);
    assert.ok(description.length <= 1024, `${entry.name}: description longer than 1024 characters`);
    // The description is how the agent decides to load it, so a vague one is a silent failure.
    assert.ok(description.length >= 60, `${entry.name}: description too thin to select on`);
  }
  console.log(`  ${found.length} skills have a name and a description Bengacoon can select on`);

  const promptsDir = join(repoRoot, "prompts");
  const prompts = readdirSync(promptsDir).filter((file) => file.endsWith(".md"));
  assert.ok(prompts.length > 0, "no prompts found");
  for (const file of prompts) {
    const text = readFileSync(join(promptsDir, file), "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${file}: no frontmatter block`);
    const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(description, `${file}: no description`);
    assert.match(text, /\$ARGUMENTS/, `${file}: never uses its arguments`);
  }
  console.log(`  ${prompts.length} prompts declare a description and use their arguments`);

  // A prompt names its route in prose; the gate holds the routes it will plan for. They are two
  // files that have to agree, and nothing made them. Ask the gate itself rather than re-reading
  // its source, so this checks the behaviour and not a copy of the list.
  const planDir = mkdtempSync(join(tmpdir(), "workflow-checks-"));
  mkdirSync(join(planDir, ".syra"), { recursive: true });
  writeFileSync(join(planDir, ".syra", "reviews.json"), '{"version":1,"mode":"generic","general":[]}\n');
  writeTestMode(planDir, "tdd");
  let named = 0;
  for (const file of prompts) {
    const route = readFileSync(join(promptsDir, file), "utf8").match(/route is \*\*([a-z-]+)\*\*/)?.[1];
    if (!route) continue;
    named += 1;
    const planned = run(reviewGate, ["plan", "--route", route], planDir);
    assert.equal(planned.status, 0, `${file} names route "${route}", which the gate will not plan for`);
  }
  assert.ok(named > 0, "no prompt names a route, so this check proved nothing");
  console.log(`  ${named} routes named in prompts are routes the gate will plan for`);

  // Every reviewer the gate can name must have a procedure behind it. A reviewer that is offered
  // or required but has no skill still gets its verdict demanded, so it is answered by improvising
  // one — and "security=clean" lands in the receipt with nothing behind it. An empty verdict in a
  // receipt is worse than an absent reviewer: it is the fabricated evidence this refuses to sign.
  const offered = run(reviewGate, ["plan"], mkdtempSync(join(tmpdir(), "workflow-checks-")))
    .output.matchAll(/^ {2}([a-z-]+) — /gm);
  const offeredNames = [...offered].map((match) => match[1]);
  const reviewers = new Set(offeredNames);
  // A project that has written nothing still gets a real review from every reviewer it can choose,
  // in whichever mode it picked, so each one must resolve a generic checklist for every mode and
  // every layer that mode has.
  const bare = mkdtempSync(join(tmpdir(), "workflow-checks-"));
  mkdirSync(join(bare, ".syra"), { recursive: true });
  const splits = [["generic", [undefined]], ["web", ["backend", "frontend"]]];
  for (const [mode, layers] of splits) {
    writeFileSync(join(bare, ".syra", "reviews.json"), `${JSON.stringify({ version: 1, mode, general: [] })}\n`);
    for (const name of offeredNames) {
      for (const layer of layers) {
        const resolved = run(reviewGate, ["checklist", "--reviewer", name, ...(layer ? ["--layer", layer] : [])], bare);
        assert.equal(
          resolved.status,
          0,
          `reviewer "${name}" has no generic checklist in ${mode} mode${layer ? ` for ${layer}` : ""}:\n${resolved.output}`,
        );
      }
    }
  }
  rmSync(bare, { recursive: true, force: true });
  for (const file of prompts) {
    const route = readFileSync(join(promptsDir, file), "utf8").match(/route is \*\*([a-z-]+)\*\*/)?.[1];
    if (!route) continue;
    const required = run(reviewGate, ["plan", "--route", route], planDir).output.match(/^required:\s*(.+?)\s{2,}/m);
    for (const name of required[1].split(", ").filter((entry) => entry !== "none")) reviewers.add(name);
  }
  assert.ok(reviewers.size > 0, "the gate named no reviewers, so this check proved nothing");
  for (const name of reviewers) {
    const skill = join(repoRoot, "skills", `review-${name}`, "SKILL.md");
    assert.ok(
      existsSync(skill),
      `the gate can demand a "${name}" verdict, but skills/review-${name}/ does not exist, ` +
      `so that verdict would be improvised`,
    );
  }
  console.log(`  ${reviewers.size} reviewers the gate can demand have a procedure behind them`);
  rmSync(planDir, { recursive: true, force: true });
}
{
  // Project configuration lives in one directory, and every file that names a path into it was
  // updated by hand when that directory was renamed. A stale path is silent: the reviewer reads
  // nothing, finds nothing, and records a clean verdict it had no context for.
  const CONFIG_DIR = ".syra";
  const sources = [
    ...readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("skills", entry.name, "SKILL.md")),
    join("skills", "verified-change", "tests-config.md"),
    join("orchestrator", "voice", "neutral.md"),
    join("extensions", "orchestrator.ts"),
    join("scripts", "review-gate.mjs"),
  ];
  let named = 0;
  for (const relative of sources) {
    const text = readFileSync(join(repoRoot, relative), "utf8");
    // A dotted config directory that is not the one this system owns is a path left behind.
    // `.git/` is the repository's own and holds the receipt deliberately, so it is not ours to move.
    for (const [match] of text.matchAll(/(?<![\w.\/-])\.[a-z][a-z0-9-]*\/[a-z]/g)) {
      const dir = match.slice(0, match.indexOf("/"));
      if (dir === ".git") continue;
      assert.equal(dir, CONFIG_DIR, `${relative}: names "${dir}/", but project config lives in ${CONFIG_DIR}/`);
      named += 1;
    }
  }
  assert.ok(named > 0, "no file names a config path, so this check proved nothing");
  console.log(`  ${named} config paths all point at ${CONFIG_DIR}/`);
}
{
  // The instructions must not name the runtime they happen to run on, or a second runtime
  // becomes a rewrite instead of a thin adapter.
  const agnostic = [
    ...readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, "skills", entry.name, "SKILL.md")),
    join(repoRoot, "orchestrator", "RULE.md"),
    join(repoRoot, "orchestrator", "LANGUAGE.md"),
    join(repoRoot, "orchestrator", "voice", "neutral.md"),
  ];
  for (const path of agnostic) {
    const text = readFileSync(path, "utf8");
    assert.equal(/\bPi\b/.test(text), false, `${path.replace(repoRoot, ".")}: names the runtime`);
  }
  console.log(`  ${agnostic.length} instruction files stay free of the runtime they run on`);
}

console.log("workflow checks passed");
