---
name: bug-context
description: Establishes what a reported bug actually is before any code is read or written — asks whether a ticket documents it, reads that ticket, and asks for whatever is still missing. Use at the start of every bug fix, before reproducing, and stop when the failing check can be written.
---

# Before reproducing

A fix built on a half-understood report fixes what you imagined. This phase ends
when you can write the check that fails — not when a form is full.

## Ask about the ticket first

> Is this documented in a ticket anywhere — Jira, Linear, GitHub, Notion? Paste
> the link or the id, or tell me there isn't one.

Ask it once, on its own, and wait.

**Skip the question** when the request already carries a ticket reference, or
already contains everything below. Asking for a ticket that was already given, or
for detail already supplied, teaches people to route around the question.

If a ticket is named, read it with whatever tool reaches that platform. If none
does, say so and ask for the text rather than guessing at its contents — a
summary of a ticket you could not open is invention.

## What you need, whatever the source

Not fields. Three things, because without them the failing check cannot be
written:

1. **What should happen** — the expected behaviour, stated concretely.
2. **What happens instead** — the actual behaviour, with the real values if they
   were given.
3. **How to get there** — the input, the state, the sequence.

A ticket that has all three is enough. A two-line message that has all three is
also enough. A meticulous ticket missing the third is not.

## When something is missing

Ask for the missing piece specifically. Name what you have and what you do not:

> I have the expected behaviour and the error. What I am missing is what
> triggers it — which input, or which sequence, produces the wrong result?

One question, then stop and wait. Do not ask for all three at once when two are
already in hand, and do not fill a gap with a plausible assumption: a wrong
assumption here produces a check that passes while the reported bug survives.

## When it cannot be reproduced

If, with everything the reporter has, you still cannot state how to reach it,
this is not a fix. It is an investigation, and it takes the route for work whose
"done" is not yet known. Say so plainly rather than guessing at a repair.

## Carry the source forward

Record where the understanding came from — the ticket id, or that it came from
the conversation. It belongs in the commit message, so that whoever reads the
change later can find the account of the problem it was built from.

Then reproduce.
