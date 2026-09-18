# Backend Architecture Review Checklist

Generic, stack-agnostic layer- and structure-placement checklist for reviewing backend
changes, used by the `review-architecture` skill. This checklist evaluates WHERE code
lives and WHICH layer it belongs to — not code quality (`review-code`), not
performance (`review-performance`), and not security (`review-security`).

## 1. Feature-Based Screaming Architecture

The backend structure should immediately communicate WHAT the application does
(business domains/features) rather than HOW it's built (technical layers as the
top-level grouping). Each domain capability should live under its own feature
directory, however this project actually names and locates that top-level grouping
(commonly something like `features/<featureName>/`, `modules/<moduleName>/`, or your
project's equivalent — check the project-specific context file or observed structure
for the actual convention).

## 2. Feature vs Shared/Infra Decision Framework

This is the single most reusable part of this checklist — apply it near-verbatim
regardless of exact folder names:

- Ask: "Does this logic belong to a specific business domain?"
  - If YES: it belongs inside that feature's own directory.
- If NO, ask: "Is this a cross-cutting business concern (errors, dependency-inversion
  interfaces, shared business utilities)?"
  - If YES: it belongs in the shared/core-equivalent location for this project.
- If NO, ask: "Is this an infrastructure adapter (database, cache, HTTP, email,
  external API, config)?"
  - If YES: it belongs in the shared/infrastructure-equivalent location for this
    project.
- NEVER put business logic in the infrastructure layer. NEVER put infrastructure
  details (raw client calls, connection setup, wire-format concerns) inside a feature.

## 3. Standard Feature Structure (Layer Concepts)

Each feature typically separates its code into layers by responsibility. Treat these
as universal LAYER CONCEPTS — the exact folder/file names vary by project:

- **Request-handling layer** (commonly named `controllers/`, `handlers/`, `routes/`,
  or your project's equivalent): parses incoming request params/body/query, calls the
  business-logic layer, and sends the response. NO business logic here.
- **Business-logic layer** (commonly named `services/`, `usecases/`, or your project's
  equivalent): orchestrates operations, applies business rules, calls the data-access
  layer. Must NEVER access raw request/response objects directly.
- **Data-access layer** (commonly named `repositories/`, `dao/`, `stores/`, or your
  project's equivalent): all database/ORM queries live here. Must NEVER contain
  business logic — it only reads/writes data.
- **Validation layer** (commonly named `validations/`, `schemas/`, `dtos/`, or your
  project's equivalent): request validation schemas, used by the request-handling
  layer before data reaches the business-logic layer.
- **Feature-local utilities**: transformations, formatting, and calculations scoped to
  a single feature (as opposed to cross-cutting shared utilities — see the decision
  framework above).

Check the observed codebase layout for this project's actual layer names before
flagging a finding as a placement violation — a project may legitimately use different
names for the same concepts.

## 4. Layer Dependency Rules (strict top-down flow)

This is the single most valuable, most universal rule in this checklist. Keep it close
to verbatim regardless of stack:

```
Request-handling layer → Business-logic layer → Data-access layer → your data-access layer (ORM/driver/query builder)
```

- The request-handling layer depends on the business-logic layer (NEVER on the
  data-access layer directly).
- The business-logic layer depends on the data-access layer (NEVER on the raw
  ORM/driver/query builder directly, and never on the database client directly).
- The data-access layer depends on the underlying ORM/driver/query builder.
- NEVER skip layers. A request handler must NOT call the data-access layer directly.
- Cross-feature calls: the business-logic layer of one feature MAY call another
  feature's business-logic layer, but NEVER another feature's data-access layer
  directly.

A request-handling-layer file calling the data-access layer directly, or a
business-logic-layer file issuing raw queries against the database/ORM client
directly, is a genuine layer-boundary violation — flag it as CRITICAL.

## 5. Shared / Cross-Cutting Categories

The exact folder names under a project's shared/infrastructure area vary a lot; look
for these underlying CATEGORIES under whatever names this project actually uses
(check the project-specific context file first):

- **Cross-cutting error handling**: shared error classes / error-handling utilities.
- **Dependency-inversion interfaces**: ports/interfaces/abstract contracts that
  decouple business logic from concrete implementations.
- **Cross-cutting business services**: business logic genuinely shared across
  multiple features (not infrastructure, not feature-specific).
- **Shared utilities**: generic helper functions with no business meaning of their
  own, reused across features.
- **Infrastructure adapters for external systems**: caching layer, application
  configuration and environment setup, database/ORM client setup, email sending,
  HTTP client utilities/middleware, third-party API integrations.

Flag business logic found inside an infrastructure-adapter location, or infrastructure
wiring found inside a feature directory, as a violation — severity depends on how far
it deviates from the decision framework in section 2 (a business rule embedded in an
infra adapter is CRITICAL; a slightly awkward but harmless placement is WARNING).

## 6. Naming Consistency (Example, Not a Mandate)

A concrete example of the kind of internal consistency to look for — not a rule to
enforce verbatim on every project: feature directories named consistently (e.g. all
`camelCase` or all `kebab-case`, not mixed), and files within a layer following a
consistent naming pattern (e.g. `<domain>.<layer>.ts`, or whatever pattern this
project already uses). Verify naming is internally consistent with however this
project already names things. Only flag naming that is inconsistent WITHIN the project
itself (not against some external standard).

## Severity Guide for Architecture Findings

- **CRITICAL**: an actual layer-boundary violation (request-handling layer calling the
  data-access layer directly, business logic embedded in the data-access or
  infrastructure layer, a feature reaching into another feature's data-access layer
  directly, business rules living inside an infrastructure adapter).
- **WARNING**: a placement that's debatable but not a hard layer-boundary violation
  (a utility that arguably belongs in shared rather than a feature, a cross-cutting
  concern duplicated across features instead of extracted, a feature growing large
  enough that internal sub-organization should be reconsidered).
- **SUGGESTION**: naming inconsistency, minor structural polish, or an opportunity to
  align more closely with the project's own documented conventions.

## Required Response Format

### Summary

- What changed (features/layers touched)
- The structure inferred from the observed codebase layout
- Risk: LOW / MEDIUM / HIGH

### Findings

For each finding:

- `[CRITICAL]` / `[WARNING]` / `[SUGGESTION]` — Title
- Where (file/layer/feature)
- Why it matters (layer boundary, feature/shared placement, decision-framework
  reasoning)
- Required fix

### Verdict

- `PASS` (no CRITICAL or WARNING findings)
- `WARNINGS` (no CRITICAL findings, one or more WARNING findings)
- `CRITICAL_ISSUES` (one or more CRITICAL findings) — list every CRITICAL finding as a
  must-fix item.
