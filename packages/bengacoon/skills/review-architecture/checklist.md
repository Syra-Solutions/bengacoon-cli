# Architecture Review Checklist — Whole Change

Generic, stack-agnostic checklist for projects reviewed as one whole rather than as a
backend and a frontend: a CLI, a library, a package, a service with no user interface.
It evaluates WHERE code lives and WHAT it depends on — not code quality
(`review-code`), not performance (`review-performance`), and not security
(`review-security`).

A project that writes `.syra/review-context/architecture.md` replaces this checklist
entirely.

## 1. Screaming Structure

The top-level layout should say WHAT the project does, not HOW it is built. A reader
opening the repository should find its capabilities named — jobs, billing, sync —
before its mechanisms — utils, helpers, lib, common.

Flag a change that adds a new capability as scattered files under technical grouping
directories when the project already groups by capability, or that creates a
catch-all directory whose name says nothing about what lives in it.

## 2. Placement Decision Framework

Ask, for each new or moved file, in order:

- "Does this belong to one capability of the project?"
  - If YES: it lives with that capability.
- If NO: "Is it a concern shared by several capabilities — errors, contracts, shared
  domain rules?"
  - If YES: it lives in the project's shared location.
- If NO: "Is it an adapter to something outside the project — the file system, a
  process, the network, a runtime or host API, configuration?"
  - If YES: it lives at the edge, in the project's adapter location.

NEVER put decision-making logic inside an adapter. NEVER put the details of talking to
the outside world — spawning, reading files, parsing wire formats, calling a host API —
inside the logic that decides what to do.

## 3. Dependency Direction

Dependencies point from the edges toward the core, never the reverse:

```
entry points (commands, hooks, handlers)  →  core logic  ←  adapters implement what it needs
```

- Core logic must be testable without the host runtime, the network, a real process,
  or the file system. When it cannot be, a dependency points the wrong way.
- One module may use another module's public surface; it must NEVER reach into its
  internals — private files, unexported helpers, its storage format.
- No import cycles between modules.

Core logic that imports a host runtime, a process API, or a file-system call directly
where an injected dependency was possible is a genuine violation — flag it as CRITICAL
when it makes the logic impossible to test in isolation, WARNING otherwise.

## 4. Public Surface and Entry Points

- What the project exposes is deliberate: declared entry points (a manifest, an
  exports map, a registration list) match what actually exists, and nothing is
  reachable only by importing a private path.
- A change that adds an entry point registers it where the project declares entry
  points; one that removes a file removes its registration.
- Contracts between separately running parts — a marker one process writes and another
  reads, an environment variable, a file format, an exit code — are defined in ONE
  place and imported by both sides, not duplicated as literals.

A declared entry point that no longer exists, or a cross-process contract duplicated
as two independent literals, is CRITICAL: nothing fails until the two drift apart.

## 5. Where State and Configuration Live

- Every piece of persistent state has one owner module; others go through it rather
  than reading or writing the same file or key themselves.
- Configuration is read at the edges and passed inward, not read ad hoc from deep
  inside core logic.
- Project-owned configuration lives in the project's single configuration location;
  a change that introduces a second location for the same kind of setting is a
  WARNING at least.

## 6. Naming Consistency

Verify naming is internally consistent with how this project already names things —
directories, files, exported symbols. Flag only naming that is inconsistent WITHIN the
project, not naming that differs from an external standard.

## Severity Guide for Architecture Findings

- **CRITICAL**: a genuine boundary violation — core logic bound to the outside world
  where it could not be tested alone, a module reaching into another's internals, an
  import cycle, a declared entry point that does not exist, a cross-process contract
  duplicated as independent literals.
- **WARNING**: a debatable placement — a helper that arguably belongs with its only
  caller, a shared concern duplicated instead of extracted, a second configuration
  location, a module grown large enough that its internal organization should be
  reconsidered.
- **SUGGESTION**: naming inconsistency or minor structural polish.

## Required Response Format

### Summary

- What changed (capabilities and modules touched)
- Risk: LOW / MEDIUM / HIGH

### Findings

For each finding:

- `[CRITICAL]` / `[WARNING]` / `[SUGGESTION]` — Title
- Where (file / module)
- Why it matters (placement or dependency-direction reasoning)
- Required fix

### Verdict

- `PASS` (no CRITICAL or WARNING findings)
- `WARNINGS` (no CRITICAL findings, one or more WARNING findings)
- `CRITICAL_ISSUES` (one or more CRITICAL findings) — list every CRITICAL finding as a
  must-fix item.
