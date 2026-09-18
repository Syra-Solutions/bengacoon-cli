---
description: Change the shape of code without changing what it does — first proving the existing checks would catch it if that code broke, then moving it, then showing the same check still green
argument-hint: "<what to move, rename, extract or restructure>"
---

Load the `change-router` skill and follow it for this request.

The work:

$ARGUMENTS

The route is **refactor**: behaviour must come out identical. Announce it and carry on.

Start by proving the checks have teeth — break the code on purpose and watch one go
red — before moving anything. If nothing goes red, say so and stop: the first unit is
writing that check, not moving code, and refactoring without it is a bet rather than a
change.

If you find a behaviour bug while moving things, do not fix it here. Write it down and
finish the refactor; a commit that mixes the two cannot be reverted cleanly.
