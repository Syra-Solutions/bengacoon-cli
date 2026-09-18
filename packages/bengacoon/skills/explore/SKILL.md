---
name: explore
description: Answers a question about the codebase, and establishes enough understanding to route work whose shape is not yet known. Use when asked how something works, where something lives, or why something behaves as it does — and before routing when a report is too vague to act on. Changes nothing.
---

# Exploring

Two jobs, one method: answer a question about this project, or reach the point
where work that could not be routed can be.

Exploration changes nothing. That is what lets it run wide and unattended.

## Recall before reading

Load `context-memory` and search for what was already decided or already
investigated here. A question someone answered last month should not cost a
second afternoon, and a rejected approach is worth knowing before you go read
your way back to it.

## Match the breadth to the question

| The question | How to answer it |
|--------------|------------------|
| One thing, and you know roughly where | Read it. Three files is not an investigation. |
| Broad, or several independent angles | Background jobs — read-only children, up to three at once |

Reading four files yourself to answer a question is fine. Reading forty is what
the background jobs are for: they are read-only by construction, cannot leave the
repository, and return a bounded summary instead of forty files of context.

When you dispatch them, split by **angle**, not by directory — three questions
that do not overlap beat three folders that do. Three run at once; a fourth is
refused until one finishes, so choose the three that matter.

## Say what you actually found

Separate these, and never let the third pass as the first:

- **What the code does** — with the path and line, so it can be checked.
- **What you could not determine** — and what would settle it.
- **What you infer** — marked as inference.

An answer that reads as certain throughout is the failure mode here. Exploration
that hides its gaps sends the next phase off on a guess.

## Finish by naming what comes next

Exploration ends one of two ways. Say which:

- **It was a question.** Answer it. Nothing follows.
- **It was preparation.** Name the route it now unlocks: a reproducible failure,
  a change whose desired behaviour can now be stated, or a piece of work whose
  "done" still has to be decided.

If neither is true — the question is answered but the answer raises a bigger one
— say that instead of carrying on. An exploration with no end condition consumes
a session and delivers a tour.

## Record what outlasts the answer

An exploration that settled something — a constraint, a convention, why an
approach was abandoned — records it through `context-memory` before finishing.
The answer you give goes to one person in one conversation; what you record is
what stops the next person repeating the reading.

Nothing to record is a normal outcome. Say so rather than inventing a note.

## What it must not do

Change anything. Not a fix that seems obvious on the way past, not a rename, not
a tidy-up. A change found during exploration is reported, and goes through the
router like any other.
