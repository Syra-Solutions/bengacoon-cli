// Decides which reviewers a change must face, and records what they found against the exact
// content being committed.
//
//   node scripts/review-gate.mjs plan   --route reproduce
//   node scripts/review-gate.mjs record --route reproduce --verdict tests=clean \
//                                       --verdict security="not applicable: no auth surface"
//   node scripts/review-gate.mjs verify
//
// The receipt is bound to a hash of the staged diff. Review, then stage more, then commit, and
// the receipt no longer describes what is being committed — so `verify` refuses. Without that
// binding a review is a claim about a moment that has passed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Ships with the package and is not project-configurable. A project that could edit this could
// remove a reviewer its own activity depends on, and "required" would mean nothing.
const REQUIRED_BY_ROUTE = {
  reproduce: [],
  none: [],
  specify: [],
  refactor: [],
};

// Whether a project writes tests is its own decision, made once in .syra/tests.json. What follows
// from that decision is not: a project that writes tests always has them reviewed, and one that
// does not has nothing for that reviewer to read. Each commit's receipt records which it was.
const REQUIRED_BY_TEST_MODE = {
  tdd: ["tests"],
  tad: ["tests"],
  none: [],
};
const TESTS_CONFIG_PATH = ".syra/tests.json";

// Offered once, when the project has no reviews file. Adding one here adds it to the question.
// Each one reviews against exactly one checklist, resolved by the `checklist` command below.
const OFFERED = [
  { name: "security", asks: "Review changes for security risk?" },
  { name: "performance", asks: "Review changes for performance and scalability risk?" },
  { name: "architecture", asks: "Review where changed code lives and which layer it depends on?" },
  { name: "code", asks: "Review changed code for readability, design and type safety?" },
];

// How a project is split for review. A web project has a backend and a frontend that deserve
// different checklists; anything else — a CLI, a library, a package of agent instructions — is
// reviewed as one whole, because forcing it into those two layers leaves most of it in neither.
const LAYERS_BY_MODE = { web: ["backend", "frontend"], generic: [] };

const CONFIG_PATH = ".syra/reviews.json";
// A commit large enough to dilute attention is reviewed worse than two smaller ones, so the
// budget exists to protect the review rather than to police the author. 400 is the figure the
// team already uses.
const DEFAULT_BUDGET_LINES = 400;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

// Inside the repository's git directory, so it is never committed. Asked of git rather than
// assumed to be `.git/`, because in a worktree `.git` is a file and the directory is elsewhere.
function receiptPath() {
  return git(["rev-parse", "--git-path", "review-receipt.json"]).trim();
}

// Marks a hook as this gate's own, so a later install can tell it apart from someone else's.
const HOOK_MARKER = "# installed-by: review-gate";

// What is actually about to be committed, not what is merely edited.
function stagedFingerprint() {
  const diff = git(["diff", "--cached"]);
  if (!diff.trim()) return undefined;
  // Authored lines only: the +++/--- headers are not changes anyone reads.
  const changed = diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length;
  return {
    hash: createHash("sha256").update(diff).digest("hex"),
    files: git(["diff", "--cached", "--name-only"]).trim().split("\n"),
    lines: changed,
  };
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (parsed?.version !== 1) {
      console.error(`${CONFIG_PATH}: unknown version ${parsed?.version}. Refusing to guess at it.`);
      process.exit(2);
    }
    // No default: guessing "web" for a project that is not would silently skip whatever falls in
    // neither layer, and guessing "generic" for one that is would review a frontend as a backend.
    if (!Object.hasOwn(LAYERS_BY_MODE, parsed.mode)) {
      console.error(`${CONFIG_PATH}: "mode" must be one of ${Object.keys(LAYERS_BY_MODE).join(", ")}, got ${JSON.stringify(parsed.mode)}.`);
      process.exit(2);
    }
    return {
      mode: parsed.mode,
      general: Array.isArray(parsed.general) ? parsed.general : [],
      budgetLines: Number.isInteger(parsed.budgetLines) && parsed.budgetLines > 0 ? parsed.budgetLines : DEFAULT_BUDGET_LINES,
    };
  } catch (error) {
    console.error(`${CONFIG_PATH}: ${error.message}`);
    process.exit(2);
  }
}

// No default here either: assuming tests are written would demand a review of tests that do not
// exist, and assuming they are not would let a project that writes them skip their review.
function readTestMode() {
  if (!existsSync(TESTS_CONFIG_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(TESTS_CONFIG_PATH, "utf8"));
    if (parsed?.version !== 1) {
      console.error(`${TESTS_CONFIG_PATH}: unknown version ${parsed?.version}. Refusing to guess at it.`);
      process.exit(2);
    }
    if (!Object.hasOwn(REQUIRED_BY_TEST_MODE, parsed.testMode)) {
      console.error(
        `${TESTS_CONFIG_PATH}: "testMode" must be one of ${Object.keys(REQUIRED_BY_TEST_MODE).join(", ")}, ` +
        `got ${JSON.stringify(parsed.testMode)}.`,
      );
      process.exit(2);
    }
    return parsed.testMode;
  } catch (error) {
    console.error(`${TESTS_CONFIG_PATH}: ${error.message}`);
    process.exit(2);
  }
}

function parseArguments(argv) {
  const options = { command: argv[0], route: undefined, verdicts: [] };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--route") { options.route = argv[index + 1]; index += 1; }
    else if (argv[index] === "--oversize-accepted") { options.oversizeAccepted = argv[index + 1]; index += 1; }
    else if (argv[index] === "--verdict") { options.verdicts.push(argv[index + 1]); index += 1; }
    else if (argv[index] === "--reviewer") { options.reviewer = argv[index + 1]; index += 1; }
    else if (argv[index] === "--layer") { options.layer = argv[index + 1]; index += 1; }
  }
  return options;
}

function planFor(route, config, testMode) {
  const byRoute = REQUIRED_BY_ROUTE[route];
  if (!byRoute) {
    console.error(`unknown route: ${route}. Expected one of ${Object.keys(REQUIRED_BY_ROUTE).join(", ")}.`);
    process.exit(2);
  }
  const required = [...new Set([...byRoute, ...REQUIRED_BY_TEST_MODE[testMode]])];
  // Selection may widen but never narrow: a reviewer the project chose is added to the
  // required set, and nothing removes one the route demands.
  return { required, chosen: config.general.filter((name) => !required.includes(name)) };
}

const options = parseArguments(process.argv.slice(2));

if (options.command === "plan") {
  const config = readConfig();
  const testMode = readTestMode();
  if (!config || !testMode) {
    console.log("unconfigured");
    console.log("Ask once, then write the file.");
    if (!config) {
      console.log(`\n${CONFIG_PATH} is missing.`);
      console.log(`Is this a web project with a backend and a frontend, or should it be reviewed as one whole?`);
      console.log(`mode: web | generic`);
      console.log(`Which of these reviewers should run?`);
      for (const entry of OFFERED) console.log(`  ${entry.name} — ${entry.asks}`);
      console.log(`  { "version": 1, "mode": "web", "general": ["security"] }   // an empty list is a valid answer`);
    }
    if (!testMode) {
      console.log(`\n${TESTS_CONFIG_PATH} is missing.`);
      console.log(`Does this project write tests — before the change, after it, or not at all?`);
      console.log(`testMode: tdd | tad | none`);
      console.log(`  { "version": 1, "testMode": "tdd" }   // layers are added as described in verified-change`);
    }
    process.exit(3);
  }
  const { required, chosen } = planFor(options.route, config, testMode);
  const testModeMeaning = {
    tdd: "a failing check first, then the change",
    tad: "the change first, then its check",
    none: "no tests are written, and none are reviewed",
  };
  console.log(`route:    ${options.route}`);
  console.log(`mode:     ${config.mode}${config.mode === "web" ? "   (one checklist per layer: backend, frontend)" : "   (one checklist for the whole change)"}`);
  console.log(`tests:    ${testMode}   (${testModeMeaning[testMode]})`);
  console.log(`required: ${required.join(", ") || "none"}          (by activity and test mode — cannot be turned off)`);
  console.log(`chosen:   ${chosen.join(", ") || "none"}   (by this project)`);
  console.log(`\nEvery one of these must appear in the receipt, with what it found or why it did`);
  console.log(`not apply. A reviewer you judge relevant may be added; none may be dropped.`);
  process.exit(0);
}

if (options.command === "record") {
  const config = readConfig();
  if (!config) { console.error(`No ${CONFIG_PATH}. Run plan first.`); process.exit(2); }
  const testMode = readTestMode();
  if (!testMode) { console.error(`No ${TESTS_CONFIG_PATH}. Run plan first.`); process.exit(2); }
  const staged = stagedFingerprint();
  if (!staged) { console.error("Nothing is staged, so there is nothing to record a review against."); process.exit(2); }

  const verdicts = {};
  for (const raw of options.verdicts) {
    const at = raw.indexOf("=");
    if (at < 1) { console.error(`--verdict expects name=outcome, got: ${raw}`); process.exit(2); }
    verdicts[raw.slice(0, at)] = raw.slice(at + 1);
  }

  // Past the budget is not forbidden, but it cannot happen by accident. Saying so out loud is
  // the point: the alternative is one enormous commit nobody reviews properly and everybody
  // waves through.
  if (staged.lines > config.budgetLines && !options.oversizeAccepted) {
    console.error(`${staged.lines} changed lines against a budget of ${config.budgetLines}.`);
    console.error("");
    console.error("Split it into work units and commit them one at a time. If it genuinely");
    console.error("cannot be split — a move, a generated file — record that deliberately:");
    console.error('  --oversize-accepted "<why this cannot be smaller>"');
    console.error("");
    console.error("Do not reach the budget by deleting comments, tests or documentation:");
    console.error("that makes the diff shorter and the change worse.");
    process.exit(1);
  }

  const { required, chosen } = planFor(options.route, config, testMode);
  const missing = [...required, ...chosen].filter((name) => !(name in verdicts));
  if (missing.length > 0) {
    console.error(`No verdict for: ${missing.join(", ")}`);
    console.error(`Every selected reviewer needs one — "not applicable" with a reason is a verdict.`);
    process.exit(1);
  }

  const receipt = receiptPath();
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, `${JSON.stringify({
    version: 1,
    route: options.route,
    // A commit with no tests is a project's choice, but it is recorded, never implied.
    testMode,
    diff: staged.hash,
    files: staged.files,
    verdicts,
    lines: staged.lines,
    ...(options.oversizeAccepted ? { oversizeAccepted: options.oversizeAccepted } : {}),
    at: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(
    `recorded ${Object.keys(verdicts).length} verdict(s) against staged diff ` +
    `${staged.hash.slice(0, 12)} (${staged.lines} lines, budget ${config.budgetLines})`,
  );
  process.exit(0);
}

if (options.command === "verify") {
  const staged = stagedFingerprint();
  if (!staged) { console.log("nothing staged"); process.exit(0); }
  if (!existsSync(receiptPath())) {
    console.error("No review receipt. The reviewers for this change have not run.");
    process.exit(1);
  }
  const receipt = JSON.parse(readFileSync(receiptPath(), "utf8"));
  if (receipt.diff !== staged.hash) {
    console.error("The review receipt does not match what is staged.");
    console.error(`  reviewed: ${receipt.diff.slice(0, 12)}`);
    console.error(`  staged:   ${staged.hash.slice(0, 12)}`);
    console.error("Something changed after the review. Review the current content and record again.");
    process.exit(1);
  }
  console.log(`receipt matches staged diff ${staged.hash.slice(0, 12)}`);
  for (const [name, outcome] of Object.entries(receipt.verdicts)) console.log(`  ${name}: ${outcome}`);
  process.exit(0);
}

// Exactly one checklist per reviewer and layer. A project's own file replaces the generic one
// entirely — the two are never combined, so what a reviewer applies is only ever what that one
// file says. Deciding it here rather than in the reviewer's instructions makes it testable.
if (options.command === "checklist") {
  if (!options.reviewer || !/^[a-z-]+$/.test(options.reviewer)) {
    console.error("usage: checklist --reviewer <name> [--layer <layer>]");
    process.exit(2);
  }
  const config = readConfig();
  if (!config) { console.error(`No ${CONFIG_PATH}. Run plan first.`); process.exit(2); }

  // The mode comes from the project, never from the caller, so a reviewer cannot pick the split
  // that suits it. A layer the mode does not have is refused rather than ignored.
  const layers = LAYERS_BY_MODE[config.mode];
  if (layers.length === 0 && options.layer !== undefined) {
    console.error(`This project is reviewed in ${config.mode} mode, which has no layers: drop --layer.`);
    process.exit(2);
  }
  if (layers.length > 0 && !layers.includes(options.layer)) {
    console.error(`This project is reviewed in ${config.mode} mode: --layer must be one of ${layers.join(", ")}.`);
    process.exit(2);
  }

  const base = options.layer ? `${options.reviewer}-${options.layer}` : options.reviewer;
  const project = join(".syra", "review-context", `${base}.md`);
  if (existsSync(project)) {
    // An empty file would replace the generic checklist with nothing, and every review against it
    // would come back clean. Refuse it rather than sign that.
    if (!readFileSync(project, "utf8").trim()) {
      console.error(`${project} is empty. Fill it in, or delete it to use the generic checklist.`);
      process.exit(1);
    }
    console.log(project);
    process.exit(0);
  }

  // The generic checklist ships with this package, beside the reviewer that uses it. In web mode a
  // layer file wins over the whole-change one, for reviewers whose generic checks differ by layer.
  const skillDir = join(import.meta.dirname, "..", "skills", `review-${options.reviewer}`);
  const candidates = options.layer ? [join(skillDir, `${options.layer}.md`)] : [];
  const generic = [...candidates, join(skillDir, "checklist.md")].find((path) => existsSync(path));
  if (!generic) {
    console.error(`No checklist for reviewer "${options.reviewer}": no ${project} and no generic one in ${skillDir}.`);
    process.exit(1);
  }
  console.log(generic);
  process.exit(0);
}

// Makes `verify` run before every commit. Without this, "reviewed before commit" holds only as long
// as the agent remembers to check, which is exactly the kind of guarantee this gate exists to
// replace. Prints one status word first — installed, current, skipped or inactive — so a caller
// can decide whether the user needs to hear about it.
//
// It never overwrites a hook it did not write, and never writes into a `core.hooksPath` directory:
// those usually belong to another hook manager and are often committed. In both cases the gate is
// not enforced, and it says so rather than pretending.
if (options.command === "install-hook") {
  let top;
  try {
    top = git(["rev-parse", "--show-toplevel"]).trim();
  } catch {
    console.log("inactive");
    console.log("Not a git repository.");
    process.exit(0);
  }
  // A project opts into review by answering the gate's question once. Until it has, a hook would
  // block commits in a repository that never chose this workflow — which, for a package installed
  // globally, would be every repository its user opens.
  if (!existsSync(join(top, CONFIG_PATH))) {
    console.log("inactive");
    console.log(`No ${CONFIG_PATH}: this project has not opted into review, so no hook is installed.`);
    process.exit(0);
  }

  let hook;
  try {
    if (git(["config", "--get", "core.hooksPath"]).trim()) {
      console.log("skipped");
      console.log("core.hooksPath is set, so hooks are managed elsewhere. Commits are not checked for a review receipt.");
      console.log(`Add this to that manager's pre-commit: node ${JSON.stringify(import.meta.filename)} verify`);
      process.exit(0);
    }
  } catch {
    // `git config --get` exits 1 when the key is unset, which is the common case.
  }
  // Relative to the working directory when git answers relatively, so anchor it to the top level.
  hook = resolve(top, git(["-C", top, "rev-parse", "--git-path", "hooks/pre-commit"]).trim());

  // Single-quoted for sh, with any single quote in the path closed, escaped and reopened.
  const quoted = `'${import.meta.filename.replaceAll("'", "'\\''")}'`;
  const script = [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Refuses a commit whose staged content has no matching review receipt.",
    `gate=${quoted}`,
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "review gate: node is not on PATH, so the review receipt cannot be checked." >&2',
    "  exit 1",
    "fi",
    'if [ ! -f "$gate" ]; then',
    '  echo "review gate: $gate no longer exists — the package moved or was removed." >&2',
    '  echo "Start a new session to reinstall the hook, or delete it: $0" >&2',
    "  exit 1",
    "fi",
    'exec node "$gate" verify',
    "",
  ].join("\n");

  if (existsSync(hook)) {
    const existing = readFileSync(hook, "utf8");
    if (!existing.includes(HOOK_MARKER)) {
      console.log("skipped");
      console.log(`${hook} already exists and was not installed by this gate. It was left untouched,`);
      console.log("so commits are not checked for a review receipt. Add this line to it:");
      console.log(`  node ${JSON.stringify(import.meta.filename)} verify || exit 1`);
      process.exit(0);
    }
    if (existing === script) {
      console.log("current");
      process.exit(0);
    }
  }

  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, script, { mode: 0o755 });
  chmodSync(hook, 0o755);
  console.log("installed");
  console.log(`${hook} now refuses a commit without a review receipt for exactly what is staged.`);
  process.exit(0);
}

console.error("expected one of: plan, record, verify, checklist, install-hook");
process.exit(2);
