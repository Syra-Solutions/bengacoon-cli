---
name: context-memory
description: Recalls what was decided about this area before work starts, and records the reasoning, the rejected options and the conventions a commit cannot carry. Use at the beginning of any work to look for prior context, and at the end to record what the diff does not say.
---

# What the commit cannot carry

A commit is the evidence of **what** was implemented. It does not carry **how**
the approach was chosen, what was considered and rejected, or which of those
judgements apply again next time.

That is what the context store is for. Everything else stays in the commit, where
it travels with the repository and needs no server.

## The two moments

**Recall** happens at the start of real work, before an approach is chosen: when
the router is about to route a change, and when `explore` is about to read. Not
on every turn — on every turn that is about to spend effort.

**Record** happens at the end of that work: after the commit, or after the answer.

## Before the work

Search for prior context on the area about to be touched — the module, the
subsystem, the kind of problem. Do it before routing, not after deciding.

What comes back is **background, not instruction**. It records what was true when
it was written, and the code has moved since. If a recalled note names a file, a
function, a flag or a command, **check it still exists** before acting on it. A
stale note followed confidently is worse than no note.

Say what you found, briefly, and say when you found nothing. Silent recall is
indistinguishable from no recall.

## After the work

Record what the diff cannot show:

- **Why this approach** — when there was a real choice, and the reason is not
  obvious from reading the result.
- **What was rejected, and why.** The most valuable half. A commit shows the road
  taken; nothing shows the three that were considered and dropped, so someone
  reconsiders them next quarter and spends the same afternoon.
- **A convention that was settled** — naming, structure, a boundary, an ordering.
  Something a future change should follow without asking again.
- **A constraint discovered** — a gotcha, a platform difference, an assumption
  that turned out false.
- **Something the person said yes or no to** that will come up again.

Give it a stable key when the topic will evolve, so a later decision updates the
same subject instead of leaving two contradictory notes behind.

## What not to record

- **Anything the commit already says.** The diff, the failing check, the
  `prove-red` output, the review verdicts. Duplicating them makes recall worse:
  every search then returns three copies of what `git log` already answers.
- **Anything derivable by reading the code.** Structure, signatures, what a
  function does. That answer is always more current in the file than in a note.
- Anything that only mattered inside this conversation.

The test before writing: **would someone six months from now reach a different
first move because of this?** If not, leave it out. A store that records
everything retrieves nothing.

## This one runs on trust

The rest of this workflow refuses to be taken at its word: `prove-red` returns
an exit code, and a review receipt is bound to the bytes it reviewed. Recall and
record have no such thing. They are instructions, and instructions get skipped
quietly — as a review phase already was here, once.

So name what you did. "Recalled two prior decisions on this module, one rejected
approach" and "recorded why the queue was chosen over polling, keyed
`architecture/job-delivery`" can be checked by a person. "Context updated"
cannot, and is what skipping looks like when it is written down.

## When there is no store

Say so and continue:

```
context store: unavailable — proceeding without prior context
```

The store is optional by design. Work does not stop for it, and no part of the
workflow's guarantees depends on it — those live in the checks and the commits.
What is lost is only the reasoning that would have carried forward, and saying so
is what keeps that loss visible.
