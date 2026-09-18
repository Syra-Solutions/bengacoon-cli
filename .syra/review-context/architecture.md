# Architecture checklist — pi-bengacoon

This file is the complete architecture checklist for this repository. It replaces the
generic one entirely.

This repository is a Pi package that ships an AI development workflow meant to be
installed, with no setup, into other projects. Most of what it ships is instructions an
agent executes. The code exists to make the guarantees in those instructions real and
checkable. The architecture question is where each thing lives, and whether the
guarantees stay in code rather than drifting into prose.

Ask of every change: **does each changed file live where this repository says that kind
of thing lives, and depend only on what it may depend on?** Report findings as
`file — where it belongs and why`, with CRITICAL / WARNING / SUGGESTION, and a verdict
of PASS / WARNINGS / CRITICAL_ISSUES.

## 1. The map

| Location | What lives there | Loaded by |
|----------|------------------|-----------|
| `skills/<name>/SKILL.md` + supporting `.md` | Workflow procedure: router, spine, context, reviewers | The agent, on demand, selected by frontmatter |
| `prompts/*.md` | Thin explicit entry points (`/fix`, `/specify`, `/change`, `/explore`) | The user, by command |
| `orchestrator/` | Always-on text: `RULE.md`, `LANGUAGE.md`, `voice/`, `context-store/` adapters | `extensions/orchestrator.ts`, every turn |
| `extensions/orchestrator.ts` | The only runtime glue for the workflow: appends the orchestrator text | Pi, per `package.json` → `pi.extensions` |
| `extensions/bengacoon.ts` + `extensions/jobs/` | The background job harness: tool, commands, runner, guard, storage, UI | Pi, per `package.json` → `pi.extensions` |
| `scripts/review-gate.mjs`, `scripts/prove-red.mjs` | Guarantees the workflow depends on, as executable decisions | Instructions, by command |
| `scripts/*-checks.mjs`, `extensions/jobs/*-checks.ts` | Verification of all of the above | `npm run check` and its layers |
| `scripts/isolated-pi.sh`, `setup-profile.sh`, `canonicalize.mjs` | Isolated development launcher | A developer, by hand |
| `.syra/` | This project's own configuration: `reviews.json`, `tests.json`, `review-context/`, optional `voice.md` | Scripts and skills, from the project root |

A new file that fits none of these rows is a WARNING until a row is agreed for it.

## 2. Two products, not coupled

The job harness (`bengacoon.ts`, `jobs/`) and the workflow (`orchestrator.ts`,
`orchestrator/`, `skills/`, `prompts/`, the gate and `prove-red`) ship in one package
but are independent.

- No production module of one product imports from the other: `extensions/orchestrator.ts`
  never imports from `extensions/jobs/`, and nothing under `extensions/jobs/` that ships
  (`runner.ts`, `child-guard.ts`, `storage.ts`, `format.ts`, `ui.ts`) imports from
  `orchestrator.ts`. A new import across them is CRITICAL.
- One known exception exists today and is not a model: `extensions/jobs/lifecycle-checks.ts`
  imports `contextStoreAdapter` from `orchestrator.ts`, because the orchestrator's in-memory
  checks were added to the only in-memory check file there was. Moving them into a check file
  of the workflow's own is a follow-up. A second check doing the same is a WARNING.
- Skills may *recommend* background jobs for broad exploration. They reach them through
  the tool the harness registers, never through its files.
- A change that serves both is two changes.

## 3. Guarantees live in code; prose only calls them

Anything the workflow promises — which reviewers a change faces, which checklist a
reviewer reads, that a receipt matches what is committed, that a check goes red without
the change, the commit size budget — is decided by a script and verified by a check.
A skill instructs the agent to run that script; it does not re-implement the decision
in words.

- A new guarantee that exists only as a sentence in a `SKILL.md` is CRITICAL. It will
  be followed most of the time, and "most of the time" is not a guarantee.
- A skill that describes a decision differently from the script that makes it is
  CRITICAL: the agent will follow the prose. Examples in a skill must use flags and
  output the script actually accepts and prints.
- Every guarantee script has cases in `scripts/workflow-checks.mjs`, each verified by
  breaking what it guards.
- Two lists that must agree — routes in prompts and routes in the gate, reviewers the
  gate offers and reviewer skills that exist — are bound by a check that asks the
  running script, not by a copy of the list.

## 4. Runtime-agnostic instructions, runtime-specific glue

The workflow is meant to run on runtimes other than Pi without a rewrite.

- `skills/`, `orchestrator/RULE.md`, `LANGUAGE.md` and `voice/` never name the runtime
  they happen to run on (checked). Runtime-specific behaviour — hook names,
  `selectedTools`, how the system prompt is appended — lives only in
  `extensions/*.ts`.
- Anything that differs per tool or product (for example, how the context store is
  reached) is an adapter under `orchestrator/context-store/`, selected in code by the
  tools actually present. A skill that names a specific product's tools directly is a
  WARNING.
- `.syra/review-context/` files, `README.md` and the checks may name Pi: they describe
  this repository, not the workflow.

## 5. What ships fixed, what a project may replace

- **Fixed in the package:** `REQUIRED_BY_ROUTE` and `REQUIRED_BY_TEST_MODE` in the
  gate, `orchestrator/LANGUAGE.md`, `orchestrator/RULE.md`, the skills themselves. A
  project cannot remove a reviewer its activity or test mode requires, or change the
  artifact language contract.
- **Project-owned, in `.syra/` only:** review mode and chosen reviewers
  (`reviews.json`), test mode and test layers (`tests.json`), complete reviewer
  checklists (`review-context/`), the voice (`voice.md`).
- A project file **replaces** its packaged counterpart and is never merged with it. A
  change that blends a project file with a packaged one is CRITICAL.
- Project configuration lives in `.syra/` and nowhere else. A second configuration
  directory, or a path to one, is CRITICAL (checked).
- Adding a configurable setting needs an answer to what happens when it is absent: the
  gate asks once and writes the file, or refuses. It never guesses a default that
  changes what gets reviewed.

## 6. The job harness modules

| Module | Owns | Must not |
|--------|------|----------|
| `runner.ts` | Job lifecycle, child processes, signals, timeouts, concurrency, output tail, redaction | Write the job file directly; decide guard policy |
| `child-guard.ts` | Path policy inside the child process | Import runner state — it runs in a different process |
| `storage.ts` | The job file, its schema version, normalization of persisted records, atomic writes | Know about processes or UI |
| `format.ts`, `ui.ts` | Presentation | Mutate records or start work |
| `bengacoon.ts` | Registration with Pi: tool, commands, session hooks, wiring | Contain lifecycle or policy logic |

- The runner receives its store and callbacks, so its lifecycle is testable in memory
  (`lifecycle-checks.ts`) without Pi or real processes. A change that makes the runner
  construct its own store or call Pi directly is CRITICAL.
- **Cross-process contracts are defined once and imported by every side**:
  `GUARD_BLOCKED_MARKER`, `CHILD_COMMAND`, `childArguments`, the child environment
  names. `scripts/conformance-checks.mjs` imports the real invocation instead of
  rebuilding it. A duplicated literal is CRITICAL, because nothing fails until the two
  copies drift.
- Persisted state changes shape only through `storage.ts`, with `SCHEMA_VERSION`
  considered on every change to what is stored.

## 7. Skills compose; they do not overlap

- `change-router` decides the route and sequences the phases. Other skills do one job
  each and are referenced by name, never copied into each other.
- A prompt loads `change-router`, states its route as `route is **<name>**`, and adds
  only what is specific to that entry point. Procedure in a prompt that also exists in
  a skill is a WARNING.
- One reviewer per dimension: `review-tests` (required by activity), and `review-security`,
  `review-performance`, `review-architecture`, `review-code` (chosen by the project).
  Each stays inside its own dimension.
- A skill's supporting files live beside its `SKILL.md` and are loaded by the step that
  needs them.
- A new skill has a directory name equal to its frontmatter `name`, and a description
  that says when to use it. Otherwise it is never selected, and nothing reports that.

## 8. Entry points and installation

- `package.json` → `pi.extensions`, `pi.skills`, `pi.prompts` declare everything Pi
  loads. A new extension that is not registered never runs. A registration whose file
  was removed breaks loading for every installer. Both are CRITICAL.
- `.pi/settings.json` installs this package into its own repository, so the repository
  is always developed under the workflow it ships.
- Installation must stay zero-setup: nothing may require an installer to copy a file,
  export a variable or run a script by hand before the workflow works. Missing project
  configuration is asked for once by the workflow itself.
- Local state stays out of the repository: the isolated profile lives under
  `$XDG_STATE_HOME/pi-bengacoon` (or `PI_BENGACOON_PROFILE_DIR`); `.bengacoon-profile/`
  and `.atl/` are ignored.

## 9. Verification has layers; a check goes in the right one

`.syra/tests.json` names them: `in-memory` (`npm test`), `real-process`
(`npm run test:runtime`), `real-pi` (`npm run check:conformance`, needs credentials).
Around them: `check:syntax`, `check:shell` and `check:workflow`. All but conformance
run in CI through `npm run check`.

- A new check lands in the cheapest layer that can actually fail for the defect it
  guards. A property of the boundary with Pi cannot be verified in memory. That is why
  the conformance layer exists.
- A new check script is wired into `npm run check`, or its absence from CI is explained.
- A new check layer is added to `.syra/tests.json`.

## Severity guide

- **CRITICAL**: a guarantee held only in prose; prose that contradicts its script; a
  project file merged with a packaged one; a second configuration location; an import
  between the two products; a duplicated cross-process contract; the runner bound to Pi
  or to a concrete store; an unregistered or dangling entry point; the runtime named in
  runtime-agnostic instructions.
- **WARNING**: a file with no agreed place; procedure duplicated between a prompt and a
  skill; a product's tools named directly in a skill; a check in a more expensive layer
  than it needs; a module grown enough to reconsider its organization.
- **SUGGESTION**: naming inconsistency, minor structural polish.

## What this review cannot do

It reads the placement of files and the direction of imports. It cannot confirm that Pi
loads what `package.json` declares, or that the agent follows a skill as written. The
first is what `check:conformance` and a real session show. The second is only visible in
a session transcript.
