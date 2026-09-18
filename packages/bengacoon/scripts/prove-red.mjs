// Step 4 of verified-change: undo the change, confirm the check fails without it, restore.
//
// A green check beside a green fix does not show the two are connected. This removes the
// change and requires the check to notice. A check that stays green here is not verifying the
// change — it is verifying something else, or nothing.
//
//   node scripts/prove-red.mjs --check "npm test" --change src/a.ts --change src/b.ts
//
// Only the paths given with --change are touched. Everything else in the working tree,
// including unrelated uncommitted work, is left alone: this must never be the reason someone
// loses something they had not committed.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep, dirname } from "node:path";

function parseArguments(argv) {
  const options = { check: undefined, change: [], baseline: "HEAD" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--check") { options.check = value; index += 1; }
    else if (flag === "--change") { options.change.push(value); index += 1; }
    else if (flag === "--baseline") { options.baseline = value; index += 1; }
    else return { error: `unknown argument: ${flag}` };
  }
  if (!options.check) return { error: "--check <command> is required" };
  if (options.change.length === 0) return { error: "at least one --change <path> is required" };
  return { options };
}

function isInside(path, root) {
  const relation = relative(root, path);
  return relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation);
}

function runCheck(command) {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return {
    passed: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function tail(text, lines = 12) {
  const all = text.split("\n");
  return all.length <= lines ? text : all.slice(-lines).join("\n");
}

const { options, error } = parseArguments(process.argv.slice(2));
if (error) {
  console.error(`prove-red: ${error}`);
  process.exit(2);
}

const worktreeRoot = resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
const outsidePath = options.change.find((path) => !isInside(resolve(path), worktreeRoot));
if (outsidePath) {
  console.error(`prove-red: --change paths must be inside the current worktree: ${outsidePath}`);
  process.exit(2);
}

const resolvedOutsidePath = options.change.find((path) => existsSync(path) && !isInside(realpathSync(path), worktreeRoot));
if (resolvedOutsidePath) {
  console.error(`prove-red: --change paths must be inside the current worktree: ${resolvedOutsidePath}`);
  process.exit(2);
}

// Capture exact bytes before touching anything, and record which paths did not exist so a
// change that added a file is restored to absent rather than to an empty file.
const snapshotDir = mkdtempSync(join(tmpdir(), "prove-red-"));
const snapshots = options.change.map((path, index) => {
  const present = existsSync(path);
  const copy = join(snapshotDir, `${index}-${basename(path)}`);
  if (present) writeFileSync(copy, readFileSync(path));
  let presentAtBaseline = false;
  try {
    execFileSync("git", ["cat-file", "-e", `${options.baseline}:${path}`], { stdio: "ignore" });
    presentAtBaseline = true;
  } catch {
    // A path absent from the baseline is an addition. It must be removed rather than checked out.
  }
  return { path, present, presentAtBaseline, copy, mode: present ? statSync(path).mode : undefined };
});

function removeAddedPath(entry) {
  if (!entry.present) return;
  // rmSync does not follow the final symlink, but it follows intermediate ones. Resolve the
  // parent first so a path through a worktree symlink cannot remove an external file.
  const parent = realpathSync(dirname(entry.path));
  if (parent !== worktreeRoot && !isInside(parent, worktreeRoot)) {
    throw new Error(`Refusing to remove an added file outside the current worktree: ${entry.path}`);
  }
  rmSync(entry.path, { force: true });
}

function restore() {
  for (const entry of snapshots) {
    if (entry.present) writeFileSync(entry.path, readFileSync(entry.copy), { mode: entry.mode });
    else rmSync(entry.path, { force: true });
  }
}

function restoredExactly() {
  return snapshots.every((entry) => {
    if (!entry.present) return !existsSync(entry.path);
    if (!existsSync(entry.path)) return false;
    return readFileSync(entry.path).equals(readFileSync(entry.copy));
  });
}

function finish(code) {
  // The snapshot is only removed once the working tree is known to match it. If it does not,
  // the copies stay on disk and their location is printed, so nothing is lost to this script.
  if (restoredExactly()) {
    rmSync(snapshotDir, { recursive: true, force: true });
  } else {
    console.error(`\nprove-red: the working tree does not match what was captured.`);
    console.error(`  Your files are intact at: ${snapshotDir}`);
    console.error(`  Restore them by hand before continuing.`);
    code = 1;
  }
  process.exit(code);
}

try {
  console.log(`check:  ${options.check}`);
  console.log(`change: ${options.change.join(", ")}\n`);

  // With the change in place the check must already pass, or there is nothing to prove: a
  // check that was never green cannot show that removing the change turned it red.
  const before = runCheck(options.check);
  if (!before.passed) {
    console.error("The check does not pass with the change in place, so step 4 cannot mean");
    console.error("anything yet. Get step 3 green first.\n");
    console.error(tail(before.output));
    finish(2);
  }
  console.log("1. with the change:    PASS");

  for (const entry of snapshots) {
    if (entry.presentAtBaseline) {
      execFileSync("git", ["checkout", options.baseline, "--", entry.path], { stdio: "pipe" });
    } else {
      removeAddedPath(entry);
    }
  }
  console.log(`2. reverted ${options.change.length} path(s) to ${options.baseline}`);

  const without = runCheck(options.check);
  console.log(`3. without the change: ${without.passed ? "PASS" : "FAIL"}`);

  restore();
  console.log("4. restored");

  if (without.passed) {
    console.error("\nThe check passes without the change, so it is not verifying the change.");
    console.error("Either the check exercises something else, or the change is not what makes");
    console.error("the difference. Both are findings — do not commit this as verified.");
    finish(1);
  }

  console.log("\nThe check fails without the change and passes with it.");
  console.log("Failure it reported without the change:\n");
  console.log(tail(without.output));
  finish(0);
} catch (thrown) {
  console.error(`\nprove-red: ${thrown?.message ?? thrown}`);
  restore();
  finish(1);
}
