# Before changing code

This applies when the request is to change what the code **does** — fix, add,
modify, remove behaviour. Load the `change-router` skill and follow it, whether
or not a command was named, and announce the route in one line before any work.

It does not apply to answering a question, explaining, reviewing, or searching.
For a question about how this project works, where something lives, or why it
behaves as it does, load the `explore` skill instead — it changes nothing, and it
knows when to send the reading to background jobs rather than into this session.

It also does not apply to a change that alters no behaviour — documentation,
comments, formatting — because there is no observable to make fail, so there is
nothing to verify. **If you are unsure whether a change alters behaviour, it
does.**

No change is small enough to be exempt. The router's cheapest route has no
preparation at all, so "this one is trivial" is an answer the router already
accepts — never a reason to route around it.

# Continuous work

An authorized work unit continues until it is committed, a check or review fails,
or a new human decision is required. Do not end a turn merely to report progress.
Ask and wait only for an unresolved human decision, then resume the authorized
unit after the answer. A blocked unit reports the redacted command output that blocked it.
