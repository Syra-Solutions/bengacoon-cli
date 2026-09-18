# Backend Code Review Checklist

Generic, stack-agnostic clean-code checklist for reviewing backend changes, used by
the `review-code` skill.

## First of All

All code should follow the SIMPLICIDAD principles (DRY, YAGNI, KISS). Always prioritize
the most impactful improvements first and acknowledge good practices when present.

A file or module should never grow unreasonably large — as a rule of thumb, flag any
single file/module that exceeds roughly 500 lines of code (adjust for the language's
idioms) and suggest splitting it into smaller, more focused units (services, handlers,
repositories).

When reviewing code, evaluate against these core principles:

**1. Descriptive Naming**
- Verify names leverage the language's type system/inference where available
- Flag generic suffixes like 'data' or 'info'
- Ensure variable, function, service, and struct/class names clearly express their
  purpose
- Suggest more descriptive alternatives when names are unclear

**2. Function and Module Design**
- Confirm functions are small and do 'one thing'
- Check that each function operates at a single level of abstraction
- Verify separation of concerns across layers (handlers/controllers, business
  logic/services, data access/repositories)
- Recommend extraction of reusable functions or modules when appropriate

**3. Immutability and State Management**
- Identify hidden side effects and warn against them
- Verify proper use of immutable data structures / copy-on-write patterns where the
  language supports them
- Check for shared mutable state that could introduce race conditions or unexpected
  coupling
- Suggest safer state-management patterns when complex mutations are present

**4. Error Handling and Fail Fast**
- Ensure all errors are properly returned, wrapped, or handled — never silently
  swallowed
- Verify assertions/guard clauses are used to fail early when preconditions aren't met
- Check for proper error logging and propagation to callers
- Flag code that could leave the system in an inconsistent state (partial writes,
  missing rollbacks)

**5. Comments and Documentation**
ALWAYS IN ENGLISH
- Verify comments explain 'why' not 'what'
- Flag functions that need comments to explain what they do (suggest renaming/refactoring
  instead)
- Check for proper doc comments on exported/public APIs
- Ensure comments focus on design decisions, edge cases, or non-intuitive reasoning

**6. Type Safety Best Practices**
- Strictly prohibit `any`/untyped escape hatches (e.g. `interface{}` misuse, `any`,
  dynamic-typing shortcuts) where the language has a real type system — suggest precise
  types or explicit narrowing instead
- Verify precise type definitions, interfaces, and function signatures
- Check effective use of the language's type system (generics, unions, utility types)
  instead of casting
- Ensure type safety throughout the codebase, including at I/O boundaries (parsing,
  deserialization)

**7. SIMPLICIDAD Principles**
- **DRY**: Identify and flag code duplication, suggest extraction of reusable
  functions/modules
- **YAGNI**: Flag over-engineering and unnecessary complexity, recommend simpler
  approaches
- **KISS**: Identify unnecessarily complex solutions and suggest simpler alternatives

## Review Process

1. Analyze the code structure and organization (layering, module boundaries)
2. Check each principle systematically
3. Provide specific, actionable feedback with code examples
4. Classify each finding as CRITICAL / WARNING / SUGGESTION (see the severity guide in
   `SKILL.md`)
5. Suggest concrete refactoring steps when needed
6. Acknowledge good practices when present

Focus on the most impactful improvements first. Provide constructive feedback that helps
improve code quality while maintaining development velocity.
