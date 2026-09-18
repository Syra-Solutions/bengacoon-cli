---
name: review-code
description: Reviews changed code against a generic backend/frontend clean-code and type-safety checklist — naming, function size, error handling, immutability, comments, and any/unknown escape hatches — or, when the project has one, its own .syra/review-context checklist instead, reporting CRITICAL/WARNING/SUGGESTION findings. Use when the review gate names code for a change, and whenever a change adds or rewrites a non-trivial function, component, or module.
---

# Reviewing whether the next change will be safe

> Will the next person to change this understand it and change it safely?

This is a standalone reviewer for clean code and type safety — the code as written,
not spec compliance. It does not review performance, security, or architecture; see
the sibling `review-performance`, `review-security`, and `review-architecture` skills
for those.

## Step 1: Identify changed files

Determine the changed file set via `git diff` (or `git diff --name-only`), scoped to
the current branch against its base — fall back to `git diff HEAD` for uncommitted
changes when no base is obvious.

## Step 2: Resolve the checklist, and with it how the change is split

Ask the gate, without a layer:

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs checklist --reviewer code
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

When the project has written its own — `.syra/review-context/code.md` in generic mode,
`.syra/review-context/code-backend.md` and its frontend sibling in web mode — that file
**is** the checklist, the whole of it. This skill's generic checklist is not read at
all, not even as background. The team wrote down what a code review means in this
repository, and blending the generic list back in is how a review drifts from what was
agreed. Without a project file, the path is the generic checklist.

Read the printed file and nothing else. If the command fails for any reason other than
naming the layers it needs, report the failure and stop — never fall back to a
checklist of your own choosing.

## Step 4: Run the review

Read enough of each changed file — and its immediate surroundings — to evaluate it;
do not review from the diff hunk alone when a principle (function size, naming
consistency, duplication) needs whole-file context. Apply the matching checklist(s)
and acknowledge good practices when present — this is a review, not just a complaint
list. Report findings as `file:line — the violated principle and a concrete fix`,
grouped by checklist (Backend / Frontend) when both were touched.

## Severity vocabulary

Individual findings:
- **CRITICAL** — a genuine clean-code or type-safety violation likely to cause bugs,
  data loss, or serious maintainability harm.
- **WARNING** — a real violation of the checklist that should be fixed but is not
  immediately dangerous.
- **SUGGESTION** — a stylistic or non-blocking improvement.

Overall verdict: **PASS** (no findings), **WARNINGS** (only WARNING/SUGGESTION
findings), **CRITICAL_ISSUES** (at least one CRITICAL finding).

The verdict must say what it ran against:

```
--verdict code="PASS, against .syra/review-context/code-backend.md"
--verdict code="WARNINGS, against the generic checklist — no .syra/review-context/code-frontend.md"
```

## Stay in your dimension

Do not fix issues — report them. Do not review performance, security, or architecture
concerns; those belong to `review-performance`, `review-security`, and
`review-architecture`. Use only the CRITICAL / WARNING / SUGGESTION vocabulary for
findings, and only PASS / WARNINGS / CRITICAL_ISSUES for the verdict.

## What this review cannot do

It reads. It cannot run the code, so it cannot tell a type annotation that is merely
plausible from one the compiler would actually accept, and it cannot see a race
condition that only a scheduler produces under load. A finding here is a reading of
the diff against a checklist, not evidence that the code behaves — that is what
`review-tests` and running the suite are for.
