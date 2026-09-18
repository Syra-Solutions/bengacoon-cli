---
description: Answer a question about this project — recall what was already decided, read at the cheapest depth that answers it, and change nothing
argument-hint: "<the question about the codebase>"
---

Load the `explore` skill and follow it.

The question:

$ARGUMENTS

Recall first: this may already have been answered or already been rejected.
Then match the depth to the question — read a few files yourself, and send a wide
one to the read-only background jobs rather than into this session.

Separate what the code does, with the path and line, from what you could not
determine and from what you infer. An answer that reads as certain throughout is
the failure here.

Change nothing, including the fix that looks obvious on the way past. Report it
and let it go through the router like any other change.
