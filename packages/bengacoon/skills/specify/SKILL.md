---
name: specify
description: Turns work whose "done" is not yet decided into an ordered list of work units, each with an acceptance criterion concrete enough to be written as a failing check. Use for a new feature, or any change where what success looks like still has to be settled, before the spine runs on the first unit.
---

# Deciding what "done" means

This does not produce a specification. It produces a list, and the list is the
only artifact: work units in order, each with one line saying what finished looks
like.

No objective section, no scope section, no evidence section. Evidence lives in
the commits; why an approach was chosen and what was rejected lives in the
context store. A section here for either would be filled in by hand, and a
hand-filled evidence section is how this repository once reported that everything
passed while its launcher could not start.

## First, what is actually wanted

Three things, and they are not the bug ones:

1. **What problem** — for the person using this, not for the codebase.
2. **For whom** — which user, which case. "Everyone" usually means it has not
   been thought about yet.
3. **How we will know it is solved** — the observable that is different
   afterwards.

Ask for what is missing, one question at a time. If the third cannot be answered,
nothing below is possible: an acceptance criterion is that answer made concrete.

Read the code first when the shape of what exists matters — `explore` does that
without pulling forty files into this session.

## Then the approach, only when there is a choice

Adding a field needs no decision. Adding background jobs needs several: where
state lives, what happens on failure, what runs concurrently.

When there is a real choice, decide it and **record it through
`context-memory`** — what was chosen, and what was rejected and why. Not in this
file. A decision in the store surfaces on its own the next time someone touches
that area; a decision in a document is found only by someone who already knows to
look.

## Then the list

Write `.syra/work/<slug>.md`:

```markdown
# Volume discounts

- [ ] applyDiscount takes a percentage
      done: applyDiscount(200, 10) === 180

- [ ] quantity tiers
      done: 10 or more units applies 15%, 9 applies 0%

- [ ] the cart uses the tiers
      done: a cart of 12 units at $10 is charged $102
```

Each unit:

- **Is one deliverable behaviour.** Something that could ship, or be reverted,
  without the others.
- **Has a `done:` line that could be written as a check today** — concrete
  values, not qualities. "Handles discounts correctly" is an intention.
  `applyDiscount(200, 10) === 180` is a criterion.
- **Is ordered**, so each can be built on what came before.

The test for a unit: **can you picture the check that fails right now because it
does not exist?** If not, it is not a unit yet — it is still a wish, and the spine
will have nothing to start from.

Keep them inside the commit budget. A unit that cannot be built within it is two
units.

## Then the spine, once per unit

The list is the input to the rest of the flow: the first unit's `done:` line is
the failing check step 1 starts from. Tick a unit when its commit lands.

If a unit turns out to be wrong once you are inside it, change the list and say
so. A list that is edited during the work is honest; one that stays pristine
while the work diverges is decoration.
