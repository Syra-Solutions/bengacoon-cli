---
description: Fix a reported bug — establish what it is, reproduce it, change the minimum, verify it the way the project's test mode sets, review, and commit with the evidence
argument-hint: "<what is failing, or a ticket reference>"
---

Load the `change-router` skill and follow it for this report.

The report:

$ARGUMENTS

This is a failing behaviour, so the route is **reproduce**. Announce it and carry on rather than re-deriving it — someone who
says this is a bug knows better than a classification does.

It is a starting point, not a lock. If nothing anyone has can reproduce it, this
is an investigation, not a fix: say so and take that route instead of guessing at
a repair.

Reach the end of the sequence rather than stopping at a working change. Run
`prove-red` rather than reverting by hand whenever the test mode writes tests, let the review gate decide which
reviewers face it, and paste real output at every step — a summary of a command
is not its output.

If a step cannot be done, say which and why and stop there.
