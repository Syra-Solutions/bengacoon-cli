# Security checklist — generic

The checklist this reviewer applies when the project has no
`.syra/review-context/security-<layer>.md` of its own. When it does, that file replaces
this one entirely for that layer.

## 1. A boundary that decides on a string it never normalized

The check and the use see different strings. The check reads what was passed;
the operating system resolves something else.

The one that taught this: an allowlist compared a path against permitted roots
and refused anything outside them. `~/…` matched nothing in the list, so it fell
through as "not under a guarded root" — and the shell expanded it afterwards to
exactly the home directory the guard existed to protect.

Look for: a path, URL, host, identifier or filename compared before it is
resolved. `..`, `~`, symlinks, percent-encoding, unicode case folding, trailing
dots and slashes, and any comparison done on the raw argument.

Normalize first, then decide, then use **the normalized value**. Deciding on one
string and acting on another is the bug, regardless of which shape slipped
through.

## 2. A refusal the caller cannot tell from success

The boundary held, and everything downstream recorded a pass.

The one that taught this: a guard blocked an access and terminated the process.
The runtime exited 0, so the job was recorded `completed`. The security control
worked perfectly and the system reported that nothing had happened.

Look for: a guard that exits, terminates, returns early or swallows, without a
distinguishable signal — a marker on stderr, a specific exit code, a typed error.

A control nobody can observe failing is a control that will be removed by someone
who believes it never fires.

## 3. A denylist where an allowlist was possible

Enumerating what is forbidden is a bet that the list is complete. It never is.

Look for: a list of blocked commands, blocked paths, forbidden extensions,
sanitized characters, or dangerous patterns.

Ask whether the capability can be removed instead of enumerated. Granting read
tools and no execution tool needs no list of dangerous commands, because the
primitive is gone. That is the difference between a boundary and a filter.

## 4. Authority inherited because nobody narrowed it

The default is "everything the parent had", and the default is what ships.

The one that taught this: a child process inherited the full environment. Every
credential in the session was handed to code that needed `PATH` and a temp
directory. Narrowing it to an explicit list plus opt-ins cost six lines.

Look for: a spawned process, a request signed with ambient credentials, a token
whose scope was never stated, a database role reused because it was at hand, a
container running as root.

Ask what the smallest set is that still works, and whether anything enforces it.

## 5. A secret that moved

Secrets leak sideways — not through the code that handles them, but through the
code that reports on it.

Look for: a value added to a log line, an error message, an exception that is
re-thrown with context, a diagnostic dump, a test fixture, a snapshot file, a
URL query string, a cache key, or a file newly written to the working tree.

Check the negative case too: a redaction rule is only as good as the shapes it
knows, and a new credential format is a new shape.

## 6. Trust decided on input the sender controls

Look for: a role, tenant, price, identifier or permission read from a request
body, header, query parameter, JWT payload that is not verified, or client-side
state — and then used to decide instead of to look something up.

The pattern is the same everywhere: the client says who it is, and the server
believes it. Derive authority from the session on the server, and use the
client's value only to select among things that session may already reach.
