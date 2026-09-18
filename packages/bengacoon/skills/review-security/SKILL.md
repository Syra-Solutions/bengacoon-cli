---
name: review-security
description: Reviews a change for what it newly allows — boundaries that decide on input they never normalized, refusals a caller cannot tell from success, denylists where an allowlist was possible, inherited authority, and secrets that moved into logs, errors or fixtures. Use when the review gate names security for a change, and whenever a change touches a path, a credential, a child process, or a trust decision.
---

# Reviewing what a change newly allows

Not an audit of the repository. One question of the diff in front of you:

> **What does this let someone do that they could not do before?**

Answer it for the change, not for the system. A change that touches no boundary
has a real answer — "nothing" — and saying so is a verdict.

Report findings as `file:line — what becomes possible`. Say plainly when you
found none. A finding blocks only when the change is unsafe to ship; everything
else is recorded as follow-up.

## One checklist, and only that one

Ask the gate, without a layer:

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs checklist --reviewer security
```

The project's mode, set once in `.syra/reviews.json`, decides what happens next —
never you. If it prints one path, the project is reviewed as one whole (`generic`
mode) and that path is the checklist for every changed file. If it refuses and names
the layers, the project is reviewed in `web` mode: classify each changed file as
backend or frontend and ask again once per layer touched, with `--layer`.

In both modes, files that an agent or a tool executes as instructions — prompts,
rules, skill definitions — are code, not documentation, and a secret or a trust
decision can hide in them as easily as in source.

When the project has written its own — `.syra/review-context/security.md`, or
`security-frontend.md` and its backend sibling in web mode — that file **is** the
checklist, the whole of it: the generic one that ships with this skill is not read at
all, not even as background. The team wrote down what a security review means in this
repository, and blending a generic list back in is how a review drifts from what was
agreed. Without a project file, the path is the generic `checklist.md`.

Read the printed file and nothing else. If the command fails for any reason other
than naming the layers it needs, report the failure and stop — never fall back to a
checklist of your own choosing.

**The verdict names the file it ran against.** A clean verdict against the project's
checklist and one against the generic list are different claims, and recording them
identically is how a receipt starts meaning less than it says:

```
--verdict security="clean, against .syra/review-context/security-frontend.md"
--verdict security="clean, against the generic checklist — no .syra/review-context/security-frontend.md"
```

## What this review cannot do

It reads. It cannot prove a boundary holds — only that its reasoning looks sound
on the diff.

When a change adds or modifies a boundary, the evidence is the boundary refusing
something it should refuse, observed. `prove-red` over the guard is that evidence.
Findings here are reasons to produce it, not a substitute for it.
