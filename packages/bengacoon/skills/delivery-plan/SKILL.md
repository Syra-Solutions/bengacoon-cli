---
name: delivery-plan
description: Settles where the work will land and how it will be cut into commits, before any of it starts — a branch off the current one, and whether each completed unit gets its own commit. Use at the start of any work that will change code, whatever its route.
---

# Where this lands

Two questions, before the first line. They are asked at the start because
afterwards they are expensive: rewriting history to split a commit costs more
than deciding to split it did.

## First: a branch

> This will land on `<current branch>`. Do you want a new branch off it — say,
> `fix/<short-name>` — or commit here?

Ask it, then stop and wait.

**Skip it** when the person already said where it goes, or when the current
branch was clearly made for this work. Asking someone who just created
`feat/volume-discounts` where to put the volume discounts is noise.

## Then: how it is cut

Only when there is more than one work unit. With a single unit there is one
commit and nothing to decide.

> There are `<n>` work units here. A commit per unit as each is finished, or
> shall I group them as makes sense?

A commit per unit is the honest default and worth saying so: each one carries the
check that proves it, and each can be reverted without taking the others with it.
Grouping is a real choice and sometimes the right one — say which was chosen.

## The size is not a preference

Whatever is chosen, the review gate refuses a commit past the project's budget
unless the overage is recorded with a reason. That is not a matter of taste: a
large commit is reviewed worse than two smaller ones, and reviewed worse is the
whole cost.

If it will not fit, split by **work unit**. Never by reaching the number —
deleting comments, tests or documentation makes the diff shorter and the change
worse, and the budget was never about the character count.

## Say what was settled

One line, alongside the route:

```
branch: fix/orphan-count (new, from main) · commits: one per unit (3 expected)
```

So that someone reading later knows the shape was chosen rather than defaulted
into.
