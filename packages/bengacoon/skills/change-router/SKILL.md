---
name: change-router
description: Decides how much preparation a change needs before work starts — none, a reproduction, or a full specification — then hands off to the verified-change spine. Use at the start of any request to fix, add, modify, or remove behaviour in a repository, including when the user named no command at all.
---

# Change router

Routing decides **how much happens before the work, and what counts as evidence
for it**. It never decides whether there is evidence: every route ends with a
check that was watched failing, and a commit that carries the output.

Three routes run `verified-change`, differing only in the preparation before its
first step. `refactor` is the exception, and for one reason: it must not change
behaviour, so it has no new red to start from and carries its own steps instead.

That is what makes routing safe to do automatically: getting it wrong costs
preparation, never correctness.

## Before anything, recall

Load `context-memory` and look for prior context on the area about to be
touched. What was decided here before, and what was already rejected, changes
what preparation this needs — and it is cheapest to know before routing rather
than after committing to an approach.

## The question

Ask one thing, about the request in front of you:

> **Do you already know what "done" looks like?**

| Answer | Preparation |
|--------|-------------|
| Yes — there is a report of something failing | **`bug-context`, then reproduce.** |
| Yes — the desired behaviour is already stated | **None.** Go straight to the spine. |
| No — what "done" means still has to be decided | **`specify`, then the spine per unit.** |
| Yes — "done" is *exactly what it does today*, in a different shape | **`refactor`.** |

Route on that question, not on whether someone called it a bug. "Bug" is a
label, and labels are opinions. This question has an answer.

It also settles the awkward case: a reported bug **nobody can reproduce** is not
a fix, it is an investigation. It routes to the third row, because what "done"
looks like is exactly what is missing.

The third row is not a specification phase. `specify` produces a list of work
units with a check-able "done" each, and nothing else — the weight of that route
is in the list being right, not in a document existing.

The fourth row looks like the second — both know what "done" is — and it is a
different route because the evidence is inverted. A refactor must not change
behaviour, so it has no new red to start from, and a green suite cannot tell a
covered refactor from an uncovered one. `refactor` breaks the code on purpose
first, to find out which is true. Route there whenever the change is meant to
leave behaviour identical, even when it is small.

## Announce it

One line, before any work:

```
route: reproduce · because there is a failing behaviour reported and no spec is needed
```

Short enough to read, specific enough to contradict. If the human says it is
wrong, take the correction and move on — do not defend the classification.

## Then the same sequence, always

```
preparation (the route)  →  the work  →  review gate  →  deliver
```

The work is `verified-change` on every route but one; on `refactor` it is the
`refactor` skill's own steps, which put the proof of coverage before the change
rather than the proof of red after it.

Between the preparation and the spine, load `delivery-plan`: a branch off the
current one, and — when there is more than one work unit — whether each gets its
own commit. It comes after the preparation because a branch is named for the work
and the work is only known by then, and before the spine because splitting a
commit afterwards costs more than deciding to split it did.

`verified-change` is the work, in the order the project's test mode sets: in
`tdd` a failing check, the smallest change, green, and `prove-red` proving it goes
red again without the change; in `tad` the check comes after the change and is
proven the same way; in `none` the smallest change, shown working. For a large
change it runs **once per work unit**, not once for the whole thing.

Review comes next, over the change as a whole, once, after the last work unit.
Which reviewers face it is not yours to decide:

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs plan --route <the route you announced>
```

Some are **required** and cannot be turned off — in a project that writes tests
(`tdd` or `tad`), every change faces `review-tests`, because a check that cannot
fail is counted as protection. Others the project **chose** once. You may add a reviewer you judge relevant; you may not
drop one the plan names. If the project has never answered, the plan says so and
asks — ask once, write the file, continue.

Run each, then record what they found. `not applicable` with a reason is a
verdict; silence is not:

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs record --route <route> \
  --verdict tests=clean --verdict security="not applicable: no auth surface"
```

A finding blocks only when it means the evidence is not what it claims — a check
that does not verify the change invalidates step four, so the commit would be
recording something untrue. Everything else is recorded as follow-up and does not
stop delivery. That bound is what keeps review from becoming a loop: at most one
correction round, and findings raised about that correction are follow-ups.

Deliver is one commit per work unit with the evidence pasted in, and a pull
request when the change is large enough to need one. Then record what the commit
cannot carry — why this approach, what was rejected, what was settled — through
`context-memory`.

## Account for every phase

Close with one line per phase and what came of it:

```
recall: 1 prior decision · branch: fix/orphan-count (new) · route: reproduce · verified-change: proven (prove-red exit 0) · review-tests: 2 findings · deliver: 1 commit · recorded: 1 rejected option
```

A phase may be skipped only when it has nothing to act on — `prove-red` and
`review-tests` in a project whose test mode is `none` — and skipping is written
down as `skipped: <reason>` rather than left out. In `tdd` or `tad`, a behaviour
change that added no check has not skipped a phase; it has not done step 1 or 3.

Phases are quiet when they go missing. The accounting is what makes an omission
visible, including to whoever reads this later and assumes all of it ran.

## Escalating mid-flight

A change that turns out larger than its route can **move up** without starting
over: keep the red and the understanding already produced, and add the
preparation that was skipped.

Routes do not move down. Once specification has started, finish it — abandoning
it halfway leaves decisions half-made, which is worse than either end.

## What routing must never do

- **Skip a step of the spine.** There is no route where a change lands with less
  verification than the project's test mode requires — in `tdd` or `tad`, never
  without a check that was proven to go red without the change. The route decides
  preparation; the test mode, not the route, decides whether and when a check is
  written. If a route could lower that, a misroute would silently cost a
  guarantee, and this router would have to be right every time. It does not have
  to be right every time, and that is the point.
- **Grow.** If this file needs a third page of special cases, the spine is
  carrying too little and the router too much. Push the rule down into the spine
  instead.
