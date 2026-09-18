---
name: refactor
description: Changes the shape of code without changing what it does — starting by proving the existing checks would notice if that code broke, since a green suite alone cannot tell a covered refactor from an uncovered one. Use when moving, renaming, extracting, inlining or restructuring code whose behaviour must stay identical, including the cleanup that makes a coming change easier.
---

# Refactor

A refactor is the one change that must leave behaviour **identical**. That makes its
evidence the opposite of every other route's: there is no new red to write, because a
new red would mean the behaviour changed.

Which leaves a problem. A suite that is green after the move and a suite that never
covered the moved code are the same colour. Nothing in a green run distinguishes them,
and that is exactly how a refactor ships a silent regression.

So the first step is inverted: **break it on purpose, before moving anything.**

## 1. Prove the checks have teeth

Write a small, deliberate behaviour change to the code you are about to move — flip a
comparison, drop a branch, return a constant, skip an early return — as a patch.

```bash
node "$SYRA_SCRIPTS"/prove-covered.mjs --check "<the command that covers it>" --break <patch file>
```

It requires the check to pass first, applies the break, requires a check to fail, then
restores the files byte for byte. Exit `0` means covered, `1` means nothing noticed,
`2` means it could not be attempted.

- **Exit 0.** You now know which check is your safety net, by name. Keep its command:
  step 3 runs that same one.
- **Exit 1.** There is no safety net. This is the finding, and it changes the work:
  **the first unit is writing that check, not moving code.** Write it, prove it red on
  the same break, and only then refactor. Refactoring here is a bet that nobody would
  take if it were stated out loud — so state it out loud.

Break the behaviour, not the file's shape: renaming a local variable or reformatting is
not a break, and a check that stays green through it proves nothing.

**Paste:** the output, including which check went red.

## 2. Change the shape, not the behaviour

Move, rename, extract, inline. No new parameters, no new branches, no "while I am here"
fixes, no behaviour "improvements". A behaviour change discovered mid-refactor is a
separate work unit on its own route — write it down and do it after.

Keep it inside the commit budget. A rename across forty files is honest and mechanical;
say so and record the overage rather than splitting it into halves that do not compile.

**Paste:** the diff.

## 3. Show the same check still green

Run the exact check from step 1 — the one that went red on the break, not the whole
suite.

If it fails, the refactor changed behaviour. Do not adjust the check to match the new
code: that is how a refactor quietly redefines what "correct" means. Fix the code, or
revert and say what you learned.

**Paste:** the output.

## 4. There is no step 4

`prove-red` has nothing to prove here: the change is not supposed to make any check go
from red to green. Step 1 already bought what step 4 buys elsewhere — the knowledge
that the check is connected to this code — and it bought it before the risk was taken
rather than after.

Account for it as `prove-covered` rather than leaving the phase silent.

## 5. Commit, as ever

```bash
node "$SYRA_SCRIPTS"/review-gate.mjs verify
```

`refactor:` as the subject. The body says what moved, what it makes possible, and which
check proved it was covered — with the output pasted, not described.

A commit that mixes a refactor with a behaviour change cannot be reverted cleanly by
anyone who later finds the behaviour wrong. One or the other.

## When the mode is `none`

A project that writes no tests has nothing to break and nothing to prove. Say plainly
that the refactor is unverified, name what you read to convince yourself the behaviour
is the same, and record `refactor` with that stated. It is an honest bet then, rather
than one dressed as evidence.
