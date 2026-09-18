# Context store: Engram

The store `context-memory` refers to is Engram, and it is available in this
session. Use these rather than deciding a mechanism:

- **Recall** — `mem_context` for what the recent sessions were doing, then
  `mem_search` with terms from the area about to be touched. `mem_get_observation`
  when a result is truncated and the detail matters.
- **Record** — `mem_save`, with `title` short and searchable, and `content`
  covering what was decided, why, and what was rejected.
- **An evolving subject** — pass the same `topic_key` (for example
  `architecture/auth-model`) so a later decision updates that subject instead of
  leaving two contradictory notes behind.
- **A conflict** — when a save reports one, judge it rather than leaving it
  pending. Ask the person when the verdict is `supersedes` or `conflicts_with` on
  an architecture or policy note, and the confidence is not high.

What goes in is decided by `context-memory`, not here. This file only says which
tools that skill's instructions resolve to.
