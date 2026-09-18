# Performance checklist — pi-bengacoon

This file is the complete performance checklist for this repository. It replaces the
generic one entirely.

Most of this repository runs rarely: a command someone types, a check in CI, a script
run once per commit. Flagging those with the same weight as a hot path is how a
performance review gets ignored. What actually runs often is short, and it is listed
first.

Ask of every change: **what does this cost every turn, every tool call, or every job,
and what bounds it?** Report findings as `file:line — what grows, and with what`,
naming the dimension: turns, tool calls, concurrent jobs, output bytes, records,
tokens. Say whether each finding is measured or a hypothesis.

## Where the hot paths are

| Runs | Code | Multiplied by |
|------|------|---------------|
| Every agent turn, in every session that installs the package | `extensions/orchestrator.ts` (`before_agent_start`) and the files it appends: `orchestrator/RULE.md`, `LANGUAGE.md`, the voice, the context store adapter | turns × users |
| Every session start | every skill's frontmatter `description`, loaded so the agent can select skills | sessions × skills |
| Every read, grep, find or ls a child job makes | `extensions/jobs/child-guard.ts` (`tool_call`) | tool calls × jobs |
| Every chunk of child output | output tail handling in `extensions/jobs/runner.ts` | bytes × concurrent jobs |
| Every job state change | `storage.save` through the persist queue | state changes × records |

Everything else — `review-gate.mjs`, `prove-red.mjs`, the launcher, the checks — is
cold. Review it for correctness and for how long a developer waits, not for
throughput.

## 1. The system prompt is paid for on every turn

Whatever `orchestratorPrompt` returns is appended to the system prompt on every turn,
including turns that have nothing to do with changing code, for every user of the
package.

- **Growth in `orchestrator/*.md` is a per-turn token cost.** A paragraph added to
  `RULE.md` is paid on every turn of every session. Flag any growth there, with the
  approximate size added. The rule is meant to be a pointer to the router skill, not
  the workflow itself — anything that could live in a skill loaded on demand belongs
  in the skill.
- **The context store adapter is injected only when its tools are present.** Injecting
  it unconditionally costs tokens in every session that has no store.
- **Work in the hook runs before every turn.** It currently does a handful of small
  synchronous reads. Adding a network call, a subprocess, a directory walk, a `git`
  invocation or parsing of a large file there is CRITICAL-grade latency on every turn.
  Cache what does not change within a session.

## 2. Skill descriptions are loaded into every session

A skill's frontmatter `description` is loaded so the agent can decide whether to use
it; its body is loaded only when used.

- Descriptions are capped at 1024 characters by the checks, but each one is paid in
  every session. A new skill, or a description grown past what selection needs, is a
  finding worth one line.
- Moving procedure into a description to "make sure it is seen" is the wrong trade:
  it costs every session and still is not the procedure.
- A skill body is paid each time it loads. Supporting files (`checklist.md`,
  `backend.md`, `tests-config.md`) exist so that detail is loaded only by the step that
  needs it. Inlining them back into `SKILL.md` is a finding.

## 3. The guard runs on every tool call of every job

- `isGuardedPathInsideRoot` resolves the path and walks up to the nearest existing
  ancestor with `realpath`. That is a few system calls per tool call, which is fine.
  Adding anything heavier — reading files, spawning, network, scanning the root — is
  multiplied by every tool call of every job.
- The guard returns early for tools it does not inspect. Keep that ordering: the cheap
  name check comes before any I/O.

## 4. Job output and job concurrency are bounded — keep them bounded

- **Output is kept as a tail, not accumulated.** `OUTPUT_TAIL_BYTES` (16 KiB) caps
  what is held per job. Appending to an unbounded string or array, keeping every chunk
  "for debugging", or storing the tail per output event on disk turns a chatty job
  into a memory leak.
- **At most `MAX_CONCURRENT_JOBS` (3) run at once**, reserved synchronously. Raising the
  number is a product decision that multiplies processes, memory and API usage, and it
  needs a reason.
- **Every job has a timeout** (`DEFAULT_TIMEOUT_MS`, 10 minutes) and bounded termination
  (`TERMINATION_GRACE_MS` 5 s, `TERMINATION_CONFIRM_MS` 2 s). A code path that starts a
  child without a timeout, or waits for termination without a bound, can hold a slot
  forever.
- **Timers and listeners are per job, so they must be released per job.** A
  `setTimeout`, `setInterval` or `on(...)` added for a job and not cleared on every
  terminal path (completed, failed, cancelled, interrupted, termination unconfirmed)
  accumulates across a long session.

## 5. Persistence rewrites the whole file

- `storage.save` writes the complete record list through a temporary file and a
  `rename`, serialized by `persistQueue`. That is right for state changes. Calling it
  per output chunk, per tick or inside a loop over records is a finding: it is a full
  file rewrite each time.
- Records are capped at `MAX_RECORDS` (500) and error text at `MAX_ERROR_LENGTH`. A new
  persisted field needs its own bound.
- The persist queue must not grow without limit when saves fail; a failed attempt is
  reported through `guard` and the queue continues.

## 6. Instructions that make the agent do more work

An instruction in a skill or prompt is executed by a model, and its cost is tokens,
tool calls and time.

- **Reading breadth.** `skills/explore/` defines the ladder: a few files read directly,
  broad exploration moved into background jobs so it does not fill the session. An
  instruction that tells the agent to read whole directories, every test file or the
  full history inline is a finding.
- **Repeated work.** An instruction that runs the full check suite after every small
  step, re-reads files already read, or recalls from the context store more than once
  per phase multiplies cost without adding evidence. The spine runs `prove-red` once
  per work unit and the review gate once per change.
- **Unbounded loops.** Review is bounded to one correction round; findings about that
  correction are follow-ups. An instruction that says "repeat until clean" or "keep
  going until nothing is found" is CRITICAL, because it has no upper bound.

## 7. Checks developers actually wait for

`npm run check` runs on every push across a 2 × 2 CI matrix (ubuntu and macOS, Node
23.6 and 26), and developers run it before committing. A slow check stops being run.

- Checks that spawn processes or create scratch Git repositories (`workflow-checks.mjs`,
  `runtime-checks.ts`) should create only what each case needs and clean it up.
- A fixed `sleep` or `delay(<ms>)` is both slow and flaky. Wait for the condition — an
  event, a file, a process exit — instead.
- A new check that needs a network, credentials or a real Pi belongs in
  `check:conformance`, not in `npm run check`.
- Temporary directories under `os.tmpdir()` are removed at the end of each case, and
  `prove-red` removes its snapshot once the tree is verified. A check that leaves them
  behind fills the disk of every developer who runs it.

## 8. Distinguish a measurement from a hypothesis

Nothing above can be measured from a diff. Say which each finding is:
`orchestrator/RULE.md — adds ~600 tokens per turn, estimated from length` is honest.
`this is slow` is not a finding. When a finding matters enough to change the design,
the evidence is a measurement at a stated size — tokens per turn, milliseconds per
tool call, bytes per job.

## What this review cannot do

It cannot see how the package is used: how many turns a real session has, how many
jobs people start, how large their repositories are. It weighs the change against the
hot paths listed above. A finding outside them is a note unless the change moves code
onto one of those paths.
