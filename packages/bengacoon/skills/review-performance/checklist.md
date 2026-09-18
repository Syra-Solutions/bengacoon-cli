# Performance checklist — generic

The checklist this reviewer applies when the project has no
`.syra/review-context/performance-<layer>.md` of its own. When it does, that file replaces
this one entirely for that layer.

## 1. Work inside a loop that could have happened once

The cost is invisible at development scale, because the loop runs three times.

Look for: a query, a request, a file read, a hash, a compile, or a regex
construction inside `for`, `map`, `forEach`, or a per-item handler. In an ORM,
look for a relation accessed on each element of a list that was fetched without
it.

The tell is that the number of operations tracks the number of items rather than
the number of distinct things needed. Batch the lookup, hoist the constant, or
fetch the relation with the parent.

## 2. A collection with no upper bound

Something accumulates and nothing removes. It is correct in every test, because
tests end.

Look for: an array or map that only ever gets appended to, a cache with no
eviction and no TTL, a queue with no depth limit, a list of listeners or
subscriptions added without a matching removal, a retry that has no ceiling, a
log buffer held in memory.

Ask what bounds it. "The data is small" is a property of today's data. If the
bound is real, a limit that enforces it costs a line and turns an outage into an
error.

## 3. A whole payload loaded to use one part of it

Look for: a query with no projection where two fields are used, a file read
entirely to check its first line, a full collection fetched then filtered in
memory, an image or document decoded to read its dimensions, a JSON parse of a
response where a status code was the question.

Filter, paginate and project at the source. The cost is not only time — it is
memory held for the duration, which is what turns a slow path into a failing one
under concurrency.

## 4. Blocking the path everyone shares

One slow call on a shared path is not one slow request. It is every request
behind it.

Look for: synchronous file or network I/O on a request path or an event loop, a
long computation without a yield, a lock held across an `await`, a transaction
left open while an external call happens, a migration or backfill running inline.

On a single-threaded runtime this is sharper than it looks: CPU-bound work in a
handler stalls every other connection, not just its own.

## 5. A cost that only appears when calls overlap

The sequential measurement is fine and the system falls over anyway.

Look for: a connection, browser, worker or client created per call rather than
pooled; an unbounded fan-out (`Promise.all` over a list whose length is input);
a shared mutable structure written from concurrent handlers; a rate-limited
downstream called without a concurrency cap of its own.

The question is not how long one call takes. It is how many can be in flight,
and what is finite that they all need.

## 6. Distinguish a measurement from a hypothesis

Everything above is read from a diff, so every finding here is a hypothesis about
behaviour under conditions nobody has produced.

Say which it is. `file:line — N queries per row, unmeasured` is honest and
actionable. `file:line — this is slow` is neither, and it is how a change gets
made worse in the name of speed.

When a finding matters enough to act on, the evidence is a measurement at a
stated size, not a rewrite that feels faster.
