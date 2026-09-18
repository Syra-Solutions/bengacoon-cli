---
name: review-performance
description: Reviews a change for how it behaves at scale rather than how fast it feels — repeated work that could happen once, collections with no upper bound, whole payloads loaded to use one field, blocking on a shared path, and costs that only appear under concurrency. Use when the review gate names performance for a change, and whenever a change adds a query, a loop over data, a cache, or a shared resource.
---

# Reviewing how a change behaves at scale

Not a hunt for slow lines. One question of the diff in front of you:

> **What happens to this with 100× the data, or 100 callers at once?**

Most changes have an honest answer of "nothing" — the data is bounded and the
path is cold. Saying so is a verdict, and it is the correct one more often than
not.

Report findings as `file:line — what grows, and with what`. Name the dimension:
rows, users, concurrent requests, file size, retries. A finding without a
dimension is a feeling.

## One checklist, and only that one

Ask the gate, without a layer:

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs checklist --reviewer performance
```

The project's mode, set once in `.syra/reviews.json`, decides what happens next —
never you. If it prints one path, the project is reviewed as one whole (`generic`
mode) and that path is the checklist for every changed file. If it refuses and names
the layers, the project is reviewed in `web` mode: classify each changed file as
backend or frontend and ask again once per layer touched, with `--layer`.

When the project has written its own — `.syra/review-context/performance.md`, or
`performance-backend.md` and its frontend sibling in web mode — that file **is** the
checklist, the whole of it: the generic one that ships with this skill is not read at
all. Without a project file, the path is the generic `checklist.md`.

Read the printed file and nothing else. If the command fails for any reason other
than naming the layers it needs, report the failure and stop — never fall back to a
checklist of your own choosing.

Return the verdict and findings through `bengacoon_run_reviewer`. Its isolated
execution records the checklist and frozen diff as evidence; never supply a verdict
to the gate as caller-written text.

## What this review cannot do

It cannot tell a hot path from a cold one. A perfect N+1 in a nightly script that
processes forty rows is a note, not a defect, and treating it as one spends
review attention where there is nothing to win.

Weigh every finding against where the code actually runs. A performance review
that flags everything is read the same way as one that flags nothing.
