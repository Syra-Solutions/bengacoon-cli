// Step 1 of a refactor: show that the checks would notice if the code you are about to move
// stopped working.
//
// A refactor cannot start from a new failing check — it must not change behaviour, so there is no
// new red to write. The green suite beside it proves nothing on its own: a suite that does not
// cover this code is green too, and the two look identical from outside. So break the code on
// purpose first and watch a check go red. That red is the safety net, named.
//
//   node scripts/prove-covered.mjs --check "npm test" --break /tmp/break.patch
//
// The patch is a deliberate behaviour change to the code about to be refactored — flip a
// comparison, drop a branch, return a constant. Only the paths that patch touches are written to,
// and they are restored byte for byte afterwards.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

function parseArguments(argv) {
  const options = { check: undefined, break: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") { options.check = argv[index + 1]; index += 1; }
    else if (flag === "--break") { options.break = argv[index + 1]; index += 1; }
    else return { error: `unknown argument: ${flag}` };
  }
  if (!options.check) return { error: "--check <command> is required" };
  if (!options.break) return { error: "--break <patch file> is required" };
  if (!existsSync(options.break)) return { error: `no such patch file: ${options.break}` };
  return { options };
}

function runCheck(command) {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return { passed: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function tail(text, lines = 12) {
  const all = text.split("\n");
  return all.length <= lines ? text : all.slice(-lines).join("\n");
}

const { options, error } = parseArguments(process.argv.slice(2));
if (error) {
  console.error(`prove-covered: ${error}`);
  process.exit(2);
}

// Which files the patch touches, asked of git rather than parsed here, so nothing outside them is
// ever written to. A path the patch creates counts: it does not exist yet, and restoring means
// removing it again.
let targets;
try {
  targets = execFileSync("git", ["apply", "--numstat", "-z", options.break], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.split("\t").at(-1))
    .filter(Boolean);
} catch (thrown) {
  console.error(`prove-covered: the patch could not be read.\n${thrown?.message ?? thrown}`);
  process.exit(2);
}
if (targets.length === 0) {
  console.error("prove-covered: the patch touches no file, so it cannot break anything.");
  process.exit(2);
}

// Absent paths are recorded as absent, so a break that adds a file is undone by removing it again
// rather than left behind as a file nobody asked for.
const snapshotDir = mkdtempSync(join(tmpdir(), "prove-covered-"));
const snapshots = targets.map((path, index) => {
  const present = existsSync(path);
  const copy = join(snapshotDir, `${index}-${basename(path)}`);
  if (present) writeFileSync(copy, readFileSync(path));
  return { path, present, copy, mode: present ? statSync(path).mode : undefined };
});

function restore() {
  for (const entry of snapshots) {
    if (entry.present) writeFileSync(entry.path, readFileSync(entry.copy), { mode: entry.mode });
    else rmSync(entry.path, { force: true });
  }
}

function restoredExactly() {
  return snapshots.every((entry) => {
    if (!entry.present) return !existsSync(entry.path);
    return existsSync(entry.path) && readFileSync(entry.path).equals(readFileSync(entry.copy));
  });
}

function finish(code) {
  if (restoredExactly()) {
    rmSync(snapshotDir, { recursive: true, force: true });
  } else {
    console.error("\nprove-covered: the working tree does not match what was captured.");
    console.error(`  Your files are intact at: ${snapshotDir}`);
    console.error("  Restore them by hand before continuing.");
    code = 1;
  }
  process.exit(code);
}

try {
  console.log(`check:  ${options.check}`);
  console.log(`break:  ${options.break} (${targets.join(", ")})\n`);

  // Green before the break, or a red afterwards says nothing about the break.
  const before = runCheck(options.check);
  if (!before.passed) {
    console.error("The check does not pass on the code as it stands, so a red after breaking it");
    console.error("would prove nothing. Get it green first.\n");
    console.error(tail(before.output));
    finish(2);
  }
  console.log("1. as it stands:       PASS");

  // Exit 1 means one thing only — nothing went red — so a patch that will not apply leaves here
  // as "could not be attempted" instead, where it cannot be read as "you have no safety net".
  try {
    execFileSync("git", ["apply", options.break], { stdio: "pipe" });
  } catch (thrown) {
    console.error("\nThe patch does not apply to this tree, so nothing was broken and nothing was");
    console.error("proven. Regenerate it against the code as it stands.\n");
    console.error(`${thrown?.stderr ?? thrown?.message ?? thrown}`.trim());
    restore();
    finish(2);
  }
  console.log("2. applied the break");

  const broken = runCheck(options.check);
  console.log(`3. with it broken:     ${broken.passed ? "PASS" : "FAIL"}`);

  restore();
  console.log("4. restored");

  if (broken.passed) {
    console.error("\nNothing went red. These checks do not cover the behaviour you are about to move,");
    console.error("so a green suite after the refactor would mean nothing. Write the check that");
    console.error("catches this break first — that is the work, and the refactor waits for it.");
    finish(1);
  }

  console.log("\nA check fails when this code is broken, so it would notice if the refactor changed");
  console.log("behaviour. That is the safety net. What it reported:\n");
  console.log(tail(broken.output));
  finish(0);
} catch (thrown) {
  // Anything unexpected is "could not be attempted", never "nothing went red": the second is a
  // finding about the project's checks, and this is a failure of this script.
  console.error(`\nprove-covered: ${thrown?.message ?? thrown}`);
  restore();
  finish(2);
}
