---
name: review-tests
description: Reviews the checks in a change rather than the code they cover, looking for checks that pass for the wrong reason — sequential checks of concurrent behaviour, fixed sleeps, fixtures nobody asserted, assertions anchored on text the code removes, and overlapping protections that make a revert prove nothing. Use when reviewing a change that adds or modifies tests, and whenever a change claims to be verified.
---

# Reviewing the checks

Other review dimensions read the production code. This one reads the checks, and
asks one question of each:

> **Would this fail if the thing it claims to verify were broken?**

A check that answers no is worse than no check, because it is counted as
protection. Every pattern below comes from a check that was green while the
system was broken.

Report findings as `file:line — what would still pass`. Say plainly when you
found none.

It runs whenever the project writes tests — test mode `tdd` or `tad` — and the
review gate requires it then. In `none` there are no checks to read, and the gate
does not ask for it.

Also report the absence: in `tdd` or `tad`, a change to behaviour that arrives with
no new or modified check has skipped the step that writes one. That is a finding,
not a reason to answer `not applicable`.

## 1. A check that exercises something other than what it claims

The signature is a mismatch between what the code guards and how the check
drives it.

The one that taught this: a concurrency limit, verified by a loop that started
jobs one at a time with `await`. Correct code, correct assertion, green. It
could not fail, because awaiting each start let the previous one register before
the next one looked — the exact interleaving the limit exists for never
happened. Started concurrently instead, the limit admitted eight where it
allowed three.

Look for: a limit, lock, cache, dedupe or rate check driven sequentially. An
ordering guarantee verified with one item. A retry verified without a failure. A
concurrency guard whose check contains `await` inside a loop.

**Any counter incremented after an `await` is a candidate**, and a sequential
check cannot see it.

## 2. A fixed wait where a condition is meant

`delay(250)` before an assertion says "this usually takes less than 250ms",
which is not a property of the system. Under load it is flaky; shortened it is
silent.

Look for: `setTimeout`, `sleep`, `delay(<number>)` between an action and an
assertion.

Wait for the condition — poll for the state, await an event, resolve a promise
by hand. A fixed wait is acceptable only when the delay itself is the thing
being asserted.

## 3. A check that races its own fixture

The fixture is not ready when the check acts, so sometimes the check measures
setup instead of behaviour.

The one that taught this: a process installed a `SIGTERM` handler, then the test
signalled it. Signalled before the handler was armed, it died from the default
action and the assertion passed for the wrong reason — about three runs in four.
The real gap it was hiding stayed hidden until the flake was chased down.

Look for: a process, server, listener, subscription or watcher started and then
acted on without waiting for it to announce readiness.

**A check that passes most of the time is not a check that passes.**

## 4. A fixture nobody asserted

The check runs against data that is not what the author believes it is, and
reports a pass that means nothing.

The one that taught this: an edit stripped the interpolation out of a fixture,
so a credential-redaction check ran against empty values. Everything passed.
Nothing was verified.

Look for: a fixture built by string manipulation, templating, a file written
then read back, or a generated value — with no assertion that it contains what
the check depends on.

Assert the fixture before using it. A check should fail loudly on a wrong
fixture rather than quietly prove nothing.

## 5. An assertion anchored on something the code removes

The assertion looks for text that the code under test deletes or rewrites, so it
reports failure exactly when the code worked best.

The one that taught this: a check looked for `api_key` in output to confirm a
credential line had been echoed — but redaction removes the key name along with
the value. The detector erased itself, and reported "untested" precisely when
redaction had worked.

Look for: an assertion matching a substring that the code under test is supposed
to transform, redact, normalize, escape or strip.

Anchor on the part the code leaves alone.

## 6. Overlapping protections that make a revert prove nothing

Two rules cover the same case, so removing one changes no outcome and the check
stays green. The test appears to verify a rule it does not.

The one that taught this: two patterns matched private key blocks. Removing one
left the check green, because the other still covered every case. Both had to go
before it went red.

Look for: a change adding several rules to the same guard, validator, matcher or
allowlist — with checks that exercise the outcome rather than each rule.

Note it as a finding about what a revert would prove, not as a demand for one
check per rule.

## 7. A change that claims to be verified without evidence of it

Look for a check added or modified with no record that it was run against the
change removed — `prove-red` output, or the same evidence produced by hand.

Without it, items 1 to 6 are the only defence, and they are read rather than run.

## What this review cannot do

It reads. It cannot run anything, so it cannot tell a check that fails correctly
from one that never fails. Only removing the change and watching the check go
red does that.

Treat these findings as reasons to run `prove-red`, not as a substitute for it.
