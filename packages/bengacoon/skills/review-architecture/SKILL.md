---
name: review-architecture
description: Reviews changed files for WHERE code lives and WHICH layer it belongs to — feature vs shared/infra placement and top-down layer-dependency direction — against the project's own .syra/review-context checklist when it has one, or the generic backend/frontend checklist instead, reporting CRITICAL/WARNING/SUGGESTION findings. Use when the review gate names architecture for a change, and whenever a change adds a file, moves code between layers, or introduces a new feature or shared/infra boundary.
---

# Reviewing where code lives

> Does each changed file live where this project says that kind of thing lives, and depend only on what its layer may depend on?

This is a standalone reviewer for layer and structure placement — WHERE code lives and
WHICH layer it belongs to. It does not review code quality, performance, or security;
see the sibling `review-code`, `review-performance`, and `review-security` skills for
those.

## Step 1: Identify changed files

Determine the changed file set via `git diff` (or `git diff --name-only`), scoped to
the current branch against its base — fall back to `git diff HEAD` for uncommitted
changes when no base is obvious.

## Step 2: Resolve the checklist, and with it how the change is split

Ask the gate, without a layer:

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs checklist --reviewer architecture
```

The project's mode, set once in `.syra/reviews.json`, decides what happens next — never
you:

- **It prints one path.** The project is reviewed in `generic` mode, as one whole. That
  path is the checklist for every changed file.
- **It refuses and names the layers.** The project is reviewed in `web` mode. Classify
  each changed file and ask again once per layer the change touches, with
  `--layer backend` or `--layer frontend`. A change touching both is reviewed against
  both.
  - **Backend**: `.go`, `.py`, `.rb`, `.java`, `.cs`, and files under `server/`, `api/`,
    `service/`, `repository/`, `controller/` directories.
  - **Frontend**: `.tsx`, `.jsx`, `.vue`, `.svelte`, and files under `components/`,
    `hooks/`, `composables/`, `pages/`, `views/` directories.
  - When genuinely ambiguous, read enough of the file to decide.

In both modes, files that an agent or a tool executes as instructions — prompts, rules,
skill definitions — are code, not documentation. Skip only prose written for human
readers alone.

## Step 3: That checklist, and only that one

When the project has written its own — `.syra/review-context/architecture.md` in
generic mode, `.syra/review-context/architecture-frontend.md` and its backend sibling in
web mode — that file **is** the checklist, the whole of it. This skill's generic
checklist is not read at all, not even as background. The team wrote down where things
live in this repository, and blending the generic list back in is how a review drifts
from what was agreed.

Without a project file, the path is the generic checklist. Its folder names are
examples, so apply its principles against the structure the codebase actually has —
top-level source directories, how existing modules are organized, naming already in
use — and say in the report that the structure was inferred.

Read the printed file and nothing else. If the command fails for any reason other than
naming the layers it needs, report the failure and stop — never fall back to a
checklist of your own choosing.

## Step 4: Run the review

Apply each resolved checklist's decision framework and layering principles — using the
names it gives, or the structure inferred in the previous step —
against the relevant changed files. Report findings as `file — where it belongs and
why`, grouped by checklist (Backend / Frontend) when both were touched.

## Severity vocabulary

Individual findings: **CRITICAL** (a genuine layer-boundary violation), **WARNING**
(a debatable-but-not-a-hard-violation placement), **SUGGESTION** (naming
inconsistency or minor structural polish).

Overall verdict: **PASS** (no findings), **WARNINGS** (only WARNING/SUGGESTION
findings), **CRITICAL_ISSUES** (at least one CRITICAL finding).

Return the verdict and findings through `bengacoon_run_reviewer`. Its isolated
execution records the checklist and frozen diff as evidence; never supply a verdict
to the gate as caller-written text.

## Stay in your dimension

Do not fix issues — report them. Do not review code quality, performance, or security
concerns; those belong to `review-code`, `review-performance`, and `review-security`.
Use only the CRITICAL / WARNING / SUGGESTION vocabulary for findings, and only PASS /
WARNINGS / CRITICAL_ISSUES for the verdict.

## What this review cannot do

It reads. It cannot run the code or the build, so it cannot confirm that a dependency
it approves at a glance is not re-exported around the boundary somewhere else in the
same change, and a naming convention it accepts because no context file documented the
real one stays unverified until someone who knows the project reads it by hand. A
placement finding here is an opinion about where code belongs, not proof the system is
assembled correctly.
