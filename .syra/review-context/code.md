# Code checklist — pi-bengacoon

This file is the complete code review checklist for this repository. It replaces the
generic one entirely.

This repository has four kinds of code, and each needs a different part of this list:
JavaScript that runs inside Pi (`extensions/`), Node scripts that carry the workflow's
guarantees (`scripts/`), Bash that launches an isolated profile, and Markdown that an
agent executes (`skills/`, `prompts/`, `orchestrator/`). The last kind is code, and it
is reviewed as code.

Ask of every change: **will the next person — or the next agent — to change this
understand it and change it safely?** Report findings as `file:line — the violated
principle and a concrete fix`, with CRITICAL / WARNING / SUGGESTION, and a verdict of
PASS / WARNINGS / CRITICAL_ISSUES. Acknowledge what is done well.

## First of all

Every change follows DRY, YAGNI and KISS. The most impactful finding goes first. Flag
any single file that passes roughly 500 lines and suggest how to split it. `runner.ts`
(571), `lifecycle-checks.ts` (589) and `scripts/workflow-checks.mjs` (600+) are already
past it: a change that grows them further should say why it could not go elsewhere.

## 1. JavaScript in `.ts` files, and ES modules

- **The `.ts` files are plain JavaScript.** Node runs them through type stripping
  (`engines` ≥ 23.6), and there are no type annotations anywhere in `extensions/`. A
  type annotation, `interface`, `enum`, `namespace`, parameter property or any other
  TypeScript-only syntax is CRITICAL: depending on the construct, it either fails to
  strip or behaves differently from what the reader expects. `npm run check:syntax`
  runs `node --check` on every file, but a clean syntax check does not show that the
  code behaves the same.
- ES modules only, with `node:`-prefixed built-ins (`node:fs`, `node:path`). No
  `require`.
- No dependencies are declared. `typebox` is supplied by Pi. Any other bare import is a
  new dependency and needs a reason.
- Paths to files that ship with the package are built from `import.meta.url` or
  `import.meta.dirname`, never from `process.cwd()`. The current directory is the
  user's project, not the package.

## 2. Naming

- Names say what a thing is for in this domain: `startingJobs`, `wasStoppedByGuard`,
  `stagedFingerprint`, `isGuardedPathInsideRoot`. Generic names — `data`, `info`,
  `result2`, `handle`, `util` — are a WARNING.
- Constants that are contracts or bounds are `UPPER_SNAKE_CASE` at the top of their
  module, next to a comment saying why the value is what it is (`MAX_CONCURRENT_JOBS`,
  `OUTPUT_TAIL_BYTES`, `DEFAULT_BUDGET_LINES`). A magic number inline is a WARNING.
- Skill directories and frontmatter `name` are kebab-case and identical. Prompt files
  are named for the command they create.

## 3. Functions: decide apart from doing

- Functions are small and do one thing at one level of abstraction.
- **Decisions are separated from I/O so they can be checked without it.** `runner.ts`
  takes its store and its spawn function as constructor arguments.
  `orchestratorPrompt(cwd, selectedTools, dir)` and `contextStoreAdapter(tools, dir)`
  take everything they read as parameters. A new decision buried inside a hook
  handler, a spawn callback or a shell pipeline, where no check can reach it, is a
  WARNING. It is CRITICAL when that decision is a guarantee.
- Pi entry points (`export default function (pi)`) only register handlers and wire
  collaborators.

## 4. Concurrency and shared state

- **Anything checked before an `await` and changed after it is a race.** Reserve
  synchronously, then await: the job cap increments `startingJobs` before the first
  `await` and releases it in `finally`. A check-await-increment shape is CRITICAL. It
  shipped once, and a sequential test could not see it.
- Writes to the same file are serialized (`persistQueue`), and each save writes a
  snapshot copied before the await, not the live array.
- A promise that nobody awaits is handled explicitly. Fire-and-forget work goes through
  `guard`, which reports the failure through `onError`, rather than an unhandled
  rejection or a bare `.catch(() => {})`.

## 5. Errors, exit codes and failure that looks like success

- **Never swallow silently.** A `catch` that ignores an error carries a comment saying
  why that is safe. `extensions/bengacoon.ts` shows the shape: `// Completion delivery is
  best-effort and must not alter the job record.` A `catch {}` without that is a WARNING.
  It is CRITICAL on a path that decides a state, a verdict or a boundary.
  `readOrUndefined` in `orchestrator.ts` currently has no such comment — do not copy it.
- **Script exit codes are a contract, and "could not check" is never success.**
  `prove-red.mjs`: 0 proven, 1 the check does not verify the change, 2 could not be
  attempted. `review-gate.mjs`: 0 ok, 1 refused, 2 usage or configuration error, 3
  unconfigured. A path where a script cannot do its job and still exits 0 is CRITICAL.
  A new exit code is documented where the others are.
- **A failure must be distinguishable by whoever consumes it.** A process that exits 0
  after being blocked, a job recorded `completed` after a refusal, a check that prints
  `passed` over zero cases — each is CRITICAL. Checks that iterate over discovered
  items assert they found at least one ("so this check proved nothing").
- **Guard clauses fail fast** with a message that says what is wrong and how to fix it:
  `.syra/reviews.json: "mode" must be one of web, generic, got undefined.` A message
  that only says "invalid" is a WARNING.
- Every exit path releases what it acquired: timers, listeners, process groups,
  temporary directories, snapshots.

## 6. Validation at the edges

- Everything that arrives from outside the program is validated before use: tool
  parameters (`validateTask`), command arguments, `.syra/*.json` (version and fields
  checked, unknown versions refused rather than guessed at), persisted records
  (`normalizeRecord`), environment variables, and child output.
- Configuration with no safe default is refused when absent, not defaulted. The review
  mode is the example: a wrong default changes what gets reviewed.
- Parsing is wrapped so a malformed file produces a specific message naming the file,
  not a stack trace.

## 7. Comments

ALWAYS IN ENGLISH.

- Comments explain **why**, not what. The house style is a short paragraph that names
  the failure a line prevents: `realpath -m is GNU-only; the realpath shipped with
  macOS rejects it`. A comment that restates the code is a SUGGESTION to remove.
- A non-obvious constant, boundary, ordering or deliberate omission gets that
  explanation. Its absence on a guard, a bound or a contract is a WARNING.
- **A comment the change made untrue is CRITICAL** in this repository. People and
  agents act on these comments, and a wrong one is followed.
- Never shorten a diff to fit the commit budget by deleting comments.

## 8. Bash

- `set -euo pipefail` at the top. Every expansion is double-quoted. `CDPATH=` is cleared
  before `cd` in scripts that resolve their own location.
- **Portable across macOS and Linux.** No GNU-only flags (`realpath -m`, `sed -i` without
  a suffix, `readlink -f`). Path canonicalization goes through `canonicalize.mjs`. CI
  runs on both platforms, and a GNU-only flag is CRITICAL.
- `bash -n` checks syntax only. It passed for months on a launcher that could not start.
  Behaviour is checked by `launcher-checks.mjs`, which runs the scripts.
- No `eval`, and no building commands from strings.

## 9. Checks

The checks are code, and they are the part most likely to be wrong in a way nobody
sees.

- **Every new or changed check was run against the change removed**, with `prove-red`
  or by breaking what it guards, and went red. A check with no such evidence is a
  WARNING. It is CRITICAL when it guards a boundary.
- Concurrent behaviour is exercised concurrently (`Promise.allSettled` over concurrent
  starts), never with a loop of awaited calls.
- No fixed sleeps. Wait for the condition.
- Fixtures are asserted before use. Assertions are anchored on text the code under test
  leaves alone.
- When two rules protect the same case, removing one is not evidence. The mechanism is
  disabled as a whole.
- **Checks never run in the user's working tree.** Anything that writes, stages,
  reverts or commits runs in a scratch repository under `os.tmpdir()`, which is removed
  at the end of the case.
- A check asks the running script for its behaviour instead of re-reading the script's
  source.

## 10. Instructions an agent executes

`skills/`, `prompts/` and `orchestrator/` are the product. They are reviewed with the
same care as JavaScript, and their defects are harder to see because nothing crashes.

- **Frontmatter is the interface.** `name` equals the directory, and `description` is a
  single line of 60–1024 characters that says what the skill does and when to use it.
  A malformed skill is never loaded, and nothing reports it. The name's format and length
  and the description's length are checked; that the name equals the directory is **not**
  checked, so review it by eye.
- **Commands in instructions are exact.** Every command, flag, path and sample output
  in a skill matches what the script actually accepts and prints. A skill example using
  a flag the script refuses is CRITICAL, because the agent will copy it.
- **Scripts are run through `$SYRA_SCRIPTS`.** The skills run in projects that installed
  this package, where `scripts/` does not exist. `node "$SYRA_SCRIPTS"/review-gate.mjs`
  resolves there; `node scripts/review-gate.mjs` only resolves in this repository. A
  relative script path in an instruction is CRITICAL (checked).
- **One meaning per instruction.** Two instructions that can both apply and disagree
  are a bug. So is "should" where "must" was meant, and "consider" where a decision was
  meant. Each is a WARNING, or CRITICAL on a guarantee.
- **No unstated dependencies.** An instruction that relies on the agent remembering
  something said in another skill, without naming that skill, is a hidden side effect.
- **Runtime-agnostic.** `skills/` and `orchestrator/` never name the runtime (checked).
  Tool names specific to one product live in an adapter.
- **Bounded.** Every loop in an instruction has an exit: one correction round, one
  question at a time, stop and report when a step cannot be done.
- **Human-facing text is not generated into artifacts.** Commit messages, code comments
  and files are in English whatever language the conversation uses (`LANGUAGE.md`).
- Prompts use `$ARGUMENTS`, state their route as `route is **<name>**`, and delegate
  procedure to `change-router`.
- An instruction's prose explains why a step exists, so an agent can apply it to a case
  the text did not foresee, and then says plainly what to do.

## 11. SIMPLICIDAD

- **DRY:** a contract, a bound or a list lives in one place and is imported, or is bound
  to its copies by a check.
- **YAGNI:** no configuration option, mode, flag or abstraction without a current user.
  A setting "for later" is a WARNING.
- **KISS:** prefer removing a capability to enumerating what may not be done with it,
  and prefer a small script with a check to a long instruction.

## Review process

1. Classify each changed file into the four kinds above and read the sections that
   apply.
2. Read enough of each file around the change to judge it. Function size, naming
   consistency and duplication need the whole file.
3. Check each applicable principle.
4. Give specific, actionable findings with the fix.
5. Acknowledge what is done well.

## What this review cannot do

It reads. It cannot tell a `.ts` file that strips cleanly from one that behaves
differently after stripping, see a race that only concurrent execution produces, or
know whether an agent reads an instruction the way its author meant. The first two are
what the check layers are for. The third only shows in a session transcript.
