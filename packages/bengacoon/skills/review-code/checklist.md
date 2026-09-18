# Code Review Checklist — Whole Change

Generic, stack-agnostic clean-code checklist for projects reviewed as one whole rather
than as a backend and a frontend, used by the `review-code` skill.

A project that writes `.syra/review-context/code.md` replaces this checklist entirely.

## First of All

All code should follow the SIMPLICIDAD principles (DRY, YAGNI, KISS). Always prioritize
the most impactful improvements first and acknowledge good practices when present.

A file or module should never grow unreasonably large — as a rule of thumb, flag any
single file that exceeds roughly 500 lines (adjust for the language's idioms) and
suggest splitting it into smaller, more focused units.

Files that an agent or a tool executes as instructions — prompts, rules, skill
definitions, configuration read at runtime — are code, not documentation. Review them
with the same principles: a vague instruction is an unclear name, a contradictory one
is a bug, and one that depends on a reader remembering something unstated is a hidden
side effect.

When reviewing code, evaluate against these core principles:

**1. Descriptive Naming**
- Verify names leverage the language's type system/inference where available
- Flag generic suffixes like 'data' or 'info'
- Ensure variable, function, module, and type names clearly express their purpose
- Suggest more descriptive alternatives when names are unclear

**2. Function and Module Design**
- Confirm functions are small and do 'one thing'
- Check that each function operates at a single level of abstraction
- Verify that deciding what to do is separated from doing it (I/O, processes, network)
- Recommend extraction of reusable functions or modules when appropriate

**3. Immutability and State Management**
- Identify hidden side effects and warn against them
- Verify proper use of immutable data structures / copy-on-write patterns where the
  language supports them
- Check for shared mutable state that could introduce race conditions or unexpected
  coupling — including state read before and written after an `await`
- Suggest safer state-management patterns when complex mutations are present

**4. Error Handling and Fail Fast**
- Ensure all errors are properly returned, wrapped, or handled — never silently
  swallowed
- Verify guard clauses are used to fail early when preconditions aren't met
- Check that a failure is distinguishable from a success by whoever consumes the
  result — exit code, error type, or explicit status
- Flag code that could leave the system in an inconsistent state (partial writes,
  missing cleanup, a resource not released on the error path)

**5. Comments and Documentation**
ALWAYS IN ENGLISH
- Verify comments explain 'why' not 'what'
- Flag functions that need comments to explain what they do (suggest renaming or
  refactoring instead)
- Check for proper doc comments on exported/public APIs
- Ensure comments focus on design decisions, edge cases, or non-intuitive reasoning
- Flag a comment that the change made untrue

**6. Type Safety Best Practices**
- Strictly prohibit `any`/untyped escape hatches where the language has a real type
  system — suggest precise types or explicit narrowing instead
- Verify precise type definitions, interfaces, and function signatures
- Check effective use of the type system (generics, unions, utility types) instead of
  casting
- Ensure values from outside the program — files, environment, arguments, another
  process — are validated or narrowed before use

**7. SIMPLICIDAD Principles**
- **DRY**: Identify and flag code duplication, suggest extraction of reusable
  functions/modules
- **YAGNI**: Flag over-engineering and unnecessary complexity, recommend simpler
  approaches
- **KISS**: Identify unnecessarily complex solutions and suggest simpler alternatives

## Review Process

1. Analyze the code structure and organization (module boundaries)
2. Check each principle systematically
3. Provide specific, actionable feedback with code examples
4. Classify each finding as CRITICAL / WARNING / SUGGESTION (see the severity guide in
   `SKILL.md`)
5. Suggest concrete refactoring steps when needed
6. Acknowledge good practices when present

Focus on the most impactful improvements first. Provide constructive feedback that helps
improve code quality while maintaining development velocity.
