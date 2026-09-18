# Frontend Architecture Review Checklist

Generic, stack-agnostic layer- and structure-placement checklist for reviewing
frontend changes, used by the `review-architecture` skill. This checklist evaluates
WHERE code lives and WHICH layer/concern it belongs to — not code quality
(`review-code`), not performance (`review-performance`), and not
security (`review-security`).

## 1. Screaming Architecture

The frontend structure should immediately communicate WHAT the application does
(features) rather than HOW it's built (technical component types as the top-level
grouping). Each domain capability should live under its own feature directory,
however this project actually names and locates that top-level grouping (commonly
something like `features/<feature>/`, or your project's equivalent — check the
project-specific context file or observed structure for the actual convention).

## 2. Feature vs Global Decision Framework

Simpler and even more portable than the backend framework — apply it near-verbatim
regardless of exact folder names:

- Ask: "Does this make sense outside of this specific feature?"
  - If NO: it belongs within the feature's own directory.
  - If YES: it belongs in a global/shared location (commonly named `shared/`,
    `common/`, `ui/`, `lib/`, or your project's equivalent).

## 3. Standard Feature Structure (Category Examples, Not a Mandate)

Within each feature, code is typically organized by concern. Treat these as common
CATEGORY EXAMPLES — the exact folder names vary by project; check the observed
codebase layout for this project's actual convention before flagging a finding as a
placement violation:

- **Components**: UI and composition components specific to the feature.
- **Constants**: feature-specific constants, labels, defaults, mappings.
- **Logic-extraction layer** (React: `hooks/`; Vue: `composables/`; or your
  framework's equivalent — see section 4): custom hooks/composables containing
  extracted business logic.
- **Schemas**: validation/parsing schemas for the feature's data.
- **Services**: API access, endpoints, adapters, remote calls.
- **Store**: feature-scoped shared state (whatever state-management library this
  project uses).
- **Utils / helpers**: feature-specific utility code.
- **Types**: types used across multiple files within the feature.

A project is not expected to have all of these categories, and may use different
names for them — this list exists to help you recognize the kind of separation to
look for, not to mandate a specific folder set.

## 4. Presentational vs Logic Separation

This is a genuinely universal, portable principle for component-based frontend
frameworks — React, Vue, Svelte, and others all benefit from this separation, even
though the exact extraction mechanism is framework-dependent:

- Components should focus on UI rendering and event handling.
- Extract non-trivial logic (state management, business rules, side effects, payload
  construction) into the framework's logic-extraction primitive — "hooks" in React
  terminology specifically; this may need to be "composables" for Vue, or the
  equivalent primitive for whichever framework this project uses.
- This separation keeps components clean, testable, and reusable.

A component containing non-trivial business logic, state orchestration, or payload
construction inline (instead of extracting it to the framework's hook/composable
equivalent) is a real violation of this principle — severity depends on how much logic
is inline and how much it hurts testability/reuse (see the severity guide below).

## 5. Component-First Rule — No Native Elements When a Component Exists

A genuinely valuable, portable principle regardless of which design system a project
uses:

- Before using a native HTML element (`<button>`, `<input>`, `<select>`, `<a>`, etc.),
  always check if a shared UI component already exists in this project's design-system
  location that solves the same need (e.g. `components/ui/`, a design-system package,
  or your project's equivalent — this is a parenthetical example only, not an
  assumption that every project uses a specific library such as shadcn/ui).
- If a component exists → use it. Do not reach for the native element instead.
- If no component exists AND the need is general (i.e., it would be useful across
  multiple features, not just this one) → create a new shared component in the
  design-system location before using it in the feature.
- If the need is strictly feature-specific and not reusable, a local component within
  the feature is acceptable — but it should be documented (comment or note) why it's
  not shared.
- This applies especially to buttons, dialogs, inputs, badges, tooltips, dropdowns,
  modals, and any interactive element the project's component library may already
  provide.

## Severity Guide for Architecture Findings

- **CRITICAL**: a genuine boundary violation (feature-specific logic placed in the
  global/shared layer where it doesn't belong and pollutes it, or — more commonly on
  the frontend — global/reusable logic hard-coded inside a single feature where other
  features need the same behavior and will duplicate it; substantial business logic,
  state orchestration, or payload construction left inline in a component instead of
  extracted to a hook/composable in a way that makes the component effectively
  untestable).
- **WARNING**: a placement that's debatable but not a hard violation (a component that
  reaches for a native element when a design-system component was available, moderate
  logic left inline in a component, a util that arguably belongs in global rather than
  feature-scoped).
- **SUGGESTION**: naming inconsistency, minor structural polish, or an opportunity to
  align more closely with the project's own documented conventions.

## Required Response Format

### Summary

- What changed (features/components touched)
- The structure inferred from the observed codebase layout
- Risk: LOW / MEDIUM / HIGH

### Findings

For each finding:

- `[CRITICAL]` / `[WARNING]` / `[SUGGESTION]` — Title
- Where (file/component/feature)
- Why it matters (feature/global placement, presentational/logic separation,
  component-first reasoning)
- Required fix

### Verdict

- `PASS` (no CRITICAL or WARNING findings)
- `WARNINGS` (no CRITICAL findings, one or more WARNING findings)
- `CRITICAL_ISSUES` (one or more CRITICAL findings) — list every CRITICAL finding as a
  must-fix item.
