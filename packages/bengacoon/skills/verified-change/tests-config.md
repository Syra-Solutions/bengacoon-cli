# `.syra/tests.json`

Answers two questions for the project in front of you: **does this project write
tests, and when?** and **where do I reproduce this?** Without it the order of the
steps and the ladder in step 1 are guesses about someone else's repository.

Live in `.syra/tests.json` at the repository root.

## Shape

```json
{
  "version": 1,
  "testMode": "tdd",
  "layers": [
    {
      "name": "unit",
      "use": "Logic that can be called directly. Reach for this first.",
      "run": "npx vitest run {file}",
      "runAll": "npx vitest run",
      "files": "src/**/*.test.ts",
      "newTest": "Beside the source file, as <name>.test.ts",
      "cost": "Only when a layer is slow or spends money."
    }
  ],
  "notes": "Anything else a newcomer would have to ask about."
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `version` | Yes | Schema version. Refuse a version you do not know and say so; do not guess at it. |
| `testMode` | Yes | `tdd`, `tad` or `none` — see below. Never empty, never assumed. |
| `layers` | No | Ordered cheapest first. Absent means infer them; an empty array means there is no way to run a check — see below. |
| `layers[].name` | Yes | What to call it in a report. |
| `layers[].use` | Yes | When this layer is the right one. Prose, because it is a judgement. |
| `layers[].runAll` | Yes | Runs the whole layer. |
| `layers[].run` | No | Runs one file, `{file}` substituted. Omit when the project has no per-file runner. |
| `layers[].files` | No | Where that layer's checks live. |
| `layers[].newTest` | No | Where a new check goes. |
| `layers[].cost` | No | Say it when a layer is slow, needs credentials, or spends money. |
| `notes` | No | Anything a newcomer would otherwise have to ask. |

Commands are data: run them exactly as written, substituting `{file}` where
`run` declares it. Do not improve them.

## `testMode`

The project decides it once, for every kind of change — fixes, small changes and
work units of a feature alike. The review gate reads it, prints it in `plan`,
requires the `tests` reviewer in `tdd` and `tad`, and records it in every receipt.

| Mode | Order | `prove-red` | `tests` reviewer |
|------|-------|-------------|------------------|
| `tdd` | failing check → change → green | Yes | Required |
| `tad` | change → check → green | Yes | Required |
| `none` | change | No | Not run |

**`tdd`** anchors the check to the problem before anything is written. Step 1 ties
the check to what was reported; step 4 ties it to the change.

**`tad`** writes the check after the change, looking at it. That has a known cost,
most sharply on a bug fix: when the change is wrong but plausible, a check written
against it tends to be wrong in the same direction, and both go green. In this mode
step 4 is the only thing standing between that and a commit, so it is never skipped,
and the check must still assert what was *reported or wanted*, not what the new code
happens to do.

**`none`** writes no tests. The change is still the minimum, it is still shown to work
with whatever the project can run — a build, a type check, the existing suite, or the
steps you took and what you observed — and that is pasted. The receipt says `none`, so
a commit without tests is a visible choice, never an accident.

When the file is absent or `testMode` is missing, `plan` stops and asks. Ask the
user once, write the answer, and continue. Never assume one: assuming `tdd` demands
tests the project never agreed to write, and assuming `none` lets a project that
writes them skip their review.

## When `layers` is absent

Infer the layers from the repository, proceed, and **say in the report that you
inferred**, naming what you assumed. Never present an inferred ladder as though
it were configured.

## When `layers` is empty

The project has no way to run a check. In `tdd` or `tad`, say so and stop: there is
nothing to write the check in, so steps 3 and 4 cannot mean anything, and the
evidence would be theatre. The first work unit is test infrastructure — or the
project chooses `none` until it has some.

In `none` an empty `layers` is expected.
