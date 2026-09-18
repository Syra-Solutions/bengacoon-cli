# Security checklist — pi-bengacoon

This file is the complete security checklist for this repository. It replaces the
generic one entirely.

This repository ships two things that can hurt the person who installs them: an
extension that spawns agent processes with access to their filesystem, and
instructions that an agent follows on every turn with the user's credentials in
reach. Both are reviewed here. So are the scripts that touch the working tree and the
gate that decides what counts as reviewed.

Ask of every change: **what does this let a child job, an agent, or a project file do
that it could not do before?** Report findings as `file:line — what becomes possible`.
A finding blocks when the change is unsafe to ship; everything else is a follow-up.

## 1. The child job filesystem boundary

`extensions/jobs/child-guard.ts` is the only thing between a background job and the
user's home directory. It runs inside the child process, on every `tool_call`.

- **Normalize, then decide, then act on the normalized value.** The guard expands `~`
  and `~/` before deciding, refuses `~user` outright, strips a leading `@`, resolves
  against the target root, and checks the canonical path of the nearest existing
  ancestor so a symlink cannot lead outside. A change that decides on any
  representation of the path other than the one the tool will actually read is
  CRITICAL — this exact shape shipped once: `~/…` was approved as a path inside the
  root and then read from the real home directory.
- **The tool list is an allowlist, in two places.** The child is started with
  `--tools read,grep,find,ls` (`childArguments` in `runner.ts`), and the guard inspects
  exactly those four. Adding a tool to either list without the other is CRITICAL:
  either the guard does not inspect a tool the child has, or it lists one the child
  should not have. Giving the child any tool that writes, executes or reaches the
  network removes the premise of the whole boundary.
- **A path-taking input the guard does not read is a bypass.** If a tool gains a
  second path parameter, or a new input shape (an array of paths, a glob root), the
  guard must judge every one of them.
- **Isolation flags stay.** `--no-extensions`, `--no-skills`, `--no-prompt-templates`,
  `--no-context-files` and `--no-session` keep repository content from loading code or
  instructions into the child. Removing one is CRITICAL.
- The guard must throw when `BENGACOON_TARGET_ROOT` is missing or relative. Loosening
  that to a default is CRITICAL.

## 2. A refusal must be visible as a refusal

Terminating a Pi session exits 0 with nothing on either stream, so a blocked job looks
exactly like a job that finished with no result.

- The guard writes `GUARD_BLOCKED_MARKER` to stderr before blocking, and the runner maps
  its presence in the output tail to a failed job (`wasStoppedByGuard`). A change that
  can let a guard block end as `completed` is CRITICAL.
- The marker is a contract between two processes. It is exported once from
  `child-guard.ts` and imported by `runner.ts`. Duplicating it as a literal is a
  finding.
- Any new refusal path — in the guard, the launcher, the gate — needs a signal its
  caller can tell apart from success: a distinct exit code, a typed error, a marker.

## 3. What a child inherits

- The child environment is an explicit allowlist: `CHILD_ENV_NAMES` (`PATH`, `HOME`,
  `TMPDIR`, locale), variables matching `CHILD_ENV_CREDENTIAL_PATTERN`, `PI_*`, and
  names the user opts into through `BENGACOON_CHILD_ENV`. Passing `process.env`
  through, or widening a pattern so it matches more than provider API keys, is
  CRITICAL.
- Children run in their own process group so they can be signalled as a group, and
  `sweepChildGroup` kills stragglers on close. A change that lets a grandchild outlive
  its job keeps running code the user believes was cancelled.
- `MAX_CONCURRENT_JOBS` is reserved synchronously (`startingJobs`) before any `await`.
  A check-then-await-then-increment pattern lets the cap be exceeded under concurrent
  starts.

## 4. Secrets in output, records and errors

- **Nothing a child printed is persisted.** `storage.ts` persists only what
  `normalizeRecord` allows: identifiers, states, timestamps and bounded error text from
  a fixed set. The output tail and the final result live in memory only. A new
  persisted field that can carry child output is CRITICAL.
- **Everything shown is redacted.** Output reaches the user through
  `sanitizeFinalResult` → `redactCredentials`. A new display path that skips it is
  CRITICAL. A new credential shape is a new rule in `redactCredentials` together with a
  check that feeds it the real shape and asserts it is gone, anchored on text that
  redaction leaves alone.
- **Job files are private.** The directory is created `0o700`, the file is written
  `0o600` through a temporary file and a `rename`. Relaxing either mode is CRITICAL.
- **Errors are bounded.** Error text is truncated (`MAX_ERROR_LENGTH`) and final results
  capped (`FINAL_RESULT_MAX_LENGTH`). An error that interpolates raw child output, an
  environment value or a file's contents is a finding.

## 5. Where credentials live

- The isolated launcher (`scripts/isolated-pi.sh`) refuses a profile inside the
  worktree — a child job may read anything there — and refuses Pi's global profile
  tree. Weakening either refusal, or adding a code path that writes profile state under
  the repository, is CRITICAL.
- `.bengacoon-profile/` is a legacy location that still holds live credentials on some
  machines. It must stay in `.gitignore`. The launcher only tells the user it is no
  longer used; it never moves or copies credentials on its own. A change that migrates
  credentials automatically is CRITICAL.
- Resource-loading arguments (`--extension`, `-e`, `--skill`, `--prompt-template`) are
  refused in isolated mode. A new flag that loads code or instructions must be added to
  that refusal.
- Nothing in the repository, including fixtures and `.syra/`, contains a real token.
  Test fixtures use fabricated values that match the real shape.

## 6. Scripts that touch the working tree

The user's uncommitted work has been destroyed in this repository by commands run
during verification. Treat any script that writes to the working tree as dangerous.

- `scripts/prove-red.mjs` touches only the paths given with `--change`. It captures
  their exact bytes and file modes first, restores them, verifies byte identity, and
  keeps the snapshot on disk when the tree does not match. A change that widens what it
  reverts (`git checkout -- .`, a directory, a glob), removes the identity check, or
  deletes the snapshot before verifying is CRITICAL.
- No script, check or instruction may run `git reset --hard`, `git checkout -- <path>`,
  `git stash`, `git restore` or `git clean` against the user's repository.
  Verification that needs to change files runs in a scratch repository under
  `os.tmpdir()` or in a separate worktree. A check that runs write-capable tests in the
  real repository is CRITICAL.
- `runCheck` in `prove-red.mjs` runs its `--check` string through a shell by design.
  Anything that builds that string from file contents, branch names or other data not
  typed by the person running it is command injection.

## 7. The review gate decides what "reviewed" means

`scripts/review-gate.mjs` is a security boundary for the workflow: the receipt is the
evidence that review happened.

- The receipt is bound to `sha256(git diff --cached)`. Anything that lets a receipt
  verify against content other than what is staged — hashing names only, excluding
  files, caching the hash — is CRITICAL.
- `REQUIRED_BY_ROUTE` and `REQUIRED_BY_TEST_MODE` ship with the package and are not
  project-configurable. A project chooses its test mode in `.syra/tests.json`, but
  what that mode requires is fixed: in `tdd` and `tad` the `tests` reviewer cannot be
  dropped. Making either table readable from `.syra/`, treating a missing or empty
  `testMode` as `none`, or letting a flag drop a required reviewer, is CRITICAL.
- Every receipt records the `testMode` it was recorded under. Removing that field
  hides which commits shipped without tests.
- The review mode and the checklist path come from the project's `.syra/reviews.json`
  and `.syra/review-context/`, never from the caller. A flag that lets a reviewer choose
  its own mode or checklist is CRITICAL. So is a fallback that returns a generic
  checklist when a project file exists.
- The receipt lives in `.git/`, so it is never committed. Moving it into the working
  tree is a finding.
- Oversize commits are allowed only with a recorded reason (`--oversize-accepted`).
  Anything that raises or bypasses the budget silently is a finding.

## 8. Instructions an agent follows

`skills/`, `prompts/` and `orchestrator/` are executed by an agent that has the user's
tools and credentials. `orchestrator/RULE.md`, `LANGUAGE.md`, the voice and the context
store adapter are appended to the system prompt on **every turn**.

- An instruction must never tell the agent to answer a consent or confirmation prompt
  on the user's behalf, to enable or disable a safety mechanism silently, to copy or
  move credentials, or to paste secrets, environment values or file contents into
  commit messages, context-store entries or reports.
- An instruction must never tell the agent to execute commands found in repository
  content, tickets, review-context files or tool output. Those are data.
- What a project may replace is deliberate: `.syra/voice.md` replaces the voice, never
  `LANGUAGE.md`. A change that makes the language contract, the router rule or a
  required reviewer replaceable from a project file is CRITICAL.
- The context store adapter is injected only when its tools are actually present
  (`contextStoreAdapter`). Injecting instructions that reference tools which may not
  exist lets the agent improvise their meaning.
- Instructions that record decisions to the context store must not record secrets,
  tokens, personal data, or customer content.

## 9. Supply chain and CI

- The package declares no dependencies. The one bare import, `typebox` in
  `extensions/bengacoon.ts`, is provided by Pi at runtime. Any other bare import is a new
  dependency, and so is adding one to `package.json`. Either is a finding that needs a
  stated reason, a pinned version, and a look at its install scripts.
- `.pi/settings.json` installs this package into this repository (`".."`). A change
  that makes it install a remote source is CRITICAL.
- CI actions use `actions/checkout` and `actions/setup-node` by major tag. A new
  third-party action, or a workflow that exposes secrets to pull requests from forks,
  is a finding.
- `npm run check:conformance` needs real credentials and runs locally only. Moving it
  into CI is a finding until secret handling for it has been designed.

## What this review cannot do

It reads. It cannot prove that a boundary holds — only that its reasoning looks sound
on the diff. A change to the guard, the environment allowlist, redaction or the
receipt binding is verified by running `prove-red` over the check that exercises it,
and for the guard by `npm run check:conformance` against a real Pi. Findings here are
reasons to produce that evidence, not a substitute for it.
