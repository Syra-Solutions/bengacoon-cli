---
name: verified-change
description: The steps every code change follows, in the order the project's test mode sets — a failing check first (tdd) or after the change (tad), the minimum change, shown green, proven to go red without the change, and committed with the evidence pasted in; or, when the project writes no tests (none), the minimum change shown working. Use for every bug fix, every small change, and every work unit of a larger feature, whether or not the user named a command.
---

# Verified change

Five steps, or four when the project writes no tests. They are the same for a one-line fix and for a work unit of a large
feature. What changes between those is how much preparation happens *before*
step 1, and that is the router's decision, not this skill's.

**Every step produces output you paste. Never a summary of output.** A summary is
something you wrote; output is something that happened. This whole discipline
exists because a verification section can read as true while the system is
broken.

## The project's test mode sets the order

Whether this project writes tests, and when, is not yours to decide per change. The
review gate reads it from `.syra/tests.json` and prints it as `tests:` in `plan`:

| Mode | Steps, in order |
|------|-----------------|
| `tdd` | 1 failing check → 2 change → 3 green → 4 prove red → 5 commit |
| `tad` | 1 know what done looks like → 2 change → 3 write the check, show it green → 4 prove red → 5 commit |
| `none` | 1 know what done looks like → 2 change → 3 show it working → 5 commit |

If `plan` says the mode is not configured, ask the user once which it is and write
it, as [tests-config.md](tests-config.md) describes. Do not pick one.

The mode changes when the check is written, never whether a written check is
proven: in `tdd` and `tad` step 4 always runs. In `none` there is no check to prove,
and the receipt records `none` so that is visible.

## 1. Start from a failing check — `tdd`

In `tad` and `none`, this step is instead: **state what done looks like** —
the reported behaviour and the expected one, or the unit's `done:` line, in concrete
values — before changing anything. Nothing is written yet, but the change is aimed at
something you said out loud rather than at whatever the code ends up doing.

In `tdd`:

Produce something automated that **fails because of the problem**. That failure
is the definition of what you are about to fix or build.

Reproduce at the **lowest layer where the problem is observable**:

| Layer | Use when |
|-------|----------|
| Pure function | The problem is in logic that can be called directly |
| Component | It needs rendering, state, or interaction, but not a browser |
| HTTP handler | It is in a request/response contract |
| Browser | It only exists in a real browser: layout, navigation, focus, real network timing, storage |

Go up a layer only when the one below genuinely cannot observe it. Cost is the
reason: step 4 re-runs this check, so an expensive red is a discipline nobody
keeps. A check that runs in milliseconds gets run; one that takes a minute gets
skipped, and then none of this is happening.

Read `.syra/tests.json` for this project's actual layers and commands — it
answers this question for the repository in front of you, rather than for
repositories in general. Its shape, and what to do when it is absent or declares
no layers at all, is in [tests-config.md](tests-config.md).

Rules:
- The red must reproduce the reported problem, not a proxy for it. If the report
  is about what a user sees, a unit test of an internal helper is not the red.
- If the problem is a race, **force the ordering**. A check that fails sometimes
  is not a reproduction. Use a readiness signal, a promise you resolve by hand,
  or fake timers — never "run it several times and see".
- If you cannot produce a red, stop and say so. You do not understand the
  problem yet, and a fix from here is a guess. That is a finding, not a failure.

**Paste:** the check, and the output showing it fail.

## 2. Change the minimum

One cause, one change. If you change several things and it goes green, you do
not know which one worked, and step 4 cannot isolate anything.

**Paste:** the diff.

## 3. Show it green

In `tdd`, run **the same check from step 1**. Not the whole suite — that one.

In `tad`, write the check now, at the lowest layer where the behaviour is
observable (the ladder in step 1 applies), asserting what you stated in step 1 —
not what the new code happens to do — and run it.

A green suite alongside a check you never ran on its own proves nothing about the
connection between them.

In `none`, show the change working with whatever the project can run — a build, a
type check, the existing suite — or the exact steps you took and what you observed.
Say which it was.

**Paste:** the output showing it pass, and in `tad` the check itself.

## 4. Prove it goes red without the change — `tdd` and `tad`

Skipped in `none`: there is no check to prove.

Undo the change from step 2 — **the change, not the check** — run the check
again, confirm it fails, then restore.

Run it rather than performing it by hand:

```bash
node "$SYRA_SCRIPTS"/prove-red.mjs --check "<the command from step 1>" --change <each file the change touched>
```

It refuses when the check was never green, reverts only the paths you name,
restores them byte for byte, and keeps its copies on disk with the location
printed if the working tree ends up not matching. Exit `0` means proven, `1`
means the check passes without the change, `2` means it could not be attempted.

Doing this by hand is how the step gets skipped on a busy afternoon, and a
summary of a revert is not a revert.

This is the step almost nobody does, and it is the one that catches a check that
passes for the wrong reason.

- **Undo the whole mechanism, not one branch of it.** If the change added two
  overlapping protections, removing one proves nothing: the other still covers
  the case and the check stays green.
- **If a different check goes red than the one you expected, that is
  information.** It usually means the change is not doing what you think. Stop
  and read it before restoring.
- Restore exactly. Confirm the tree matches what it was.

What each of steps 1 and 4 buys, and why neither replaces the other:

- Step 1 ties the check to **the problem that was reported**.
- Step 4 ties the check to **the change you made**.

A check written after the change, against code you just wrote, tends to be wrong
in the same direction the change is wrong. Step 4 passes, both are green, both
are wrong. That is why `tdd` puts the check first — and why, in `tad`, the check
has to assert what step 1 stated rather than what the code does.

**Paste:** the output showing it red without the change, and the confirmation
that the tree was restored.

## 5. Commit the work unit with the evidence

Stage the work unit, then confirm the reviewers have seen exactly what is about
to be committed:

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs verify
```

It refuses when no review was recorded, and when the receipt was recorded against
different content — reviewing, then staging more, then committing is the hole it
exists to close. Do not commit past a refusal; record a review of the current
content instead.

One commit per deliverable behaviour, with a Conventional Commits subject —
`fix:`, `feat:`, `test:`, `refactor:`, `chore:`, `docs:`, `build:`, with an
optional scope. The body says what failed, why, and what proves it now, with the
output pasted rather than described.

In six months the conversation is gone and the commit is all that survives.
Someone reading `git log` should be able to reconstruct the reasoning without
asking anyone.

Keep the check with the change it verifies, in the same commit. A check that
arrives three commits later did not protect the commit it was written for.

## When a step cannot be done

Say which step, why, and what is missing — in the report and in the commit
message. Do not continue quietly.

A project in `tdd` or `tad` with no way to run a check cannot do steps 3 and 4.
Say so and stop: the first work unit is test infrastructure, or the project
chooses `none` until it has some. Reporting that honestly is worth more than
producing evidence nobody can trust.
