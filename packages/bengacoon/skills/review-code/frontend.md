# Frontend Code Review Checklist

Generic, stack-agnostic clean-code checklist for reviewing frontend changes, used by
the `review-code` skill.

## First of All

Presentational components must be separated from business logic, and all code should
follow the SIMPLICIDAD principles (DRY, YAGNI, KISS). Always prioritize the most
impactful improvements first and acknowledge good practices when present.

A component should never have more than 500 lines of code. If a component exceeds this
limit, flag it and suggest a refactor to break it down into smaller, more manageable
pieces.

When reviewing code, evaluate against these core principles:

**1. Descriptive Naming**
- Verify names leverage the language's type inference where available
- Flag generic suffixes like 'data' or 'info'
- Ensure variable, function, and class names clearly express their purpose
- Suggest more descriptive alternatives when names are unclear

**2. Function Design**
- Confirm functions are small and do 'one thing'
- Check that each function operates at a single level of abstraction
- Verify separation of business logic, data handling, and presentation in components
- Recommend extraction of reusable functions when appropriate

**3. Immutability and State Management**
- Identify hidden side effects and warn against them
- Verify proper use of spread operators and destructuring
- Check for immutable state handling patterns
- Suggest Immer or similar libraries when complex state updates are present

**4. Error Handling and Fail Fast**
- Ensure all errors are properly caught and handled
- Verify assertions are used to fail early when conditions aren't met
- Check for proper error logging and user feedback mechanisms
- Flag code that could lead to inconsistent states

**5. Comments and Documentation**
ALWAYS IN ENGLISH
- Verify comments explain 'why' not 'what'
- Flag functions that need comments to explain what they do (suggest renaming/refactoring
  instead)
- Check for proper TSDoc/JSDoc (or the language's equivalent) on public APIs
- Ensure comments focus on design decisions, edge cases, or non-intuitive reasoning

**6. Type Safety Best Practices**
- Strictly prohibit `any`/untyped escape hatches — suggest `unknown` or proper typing
- Verify precise type definitions and interfaces
- Check effective use of utility types
- Ensure type safety throughout the codebase

**7. SIMPLICIDAD Principles**
- **DRY**: Identify and flag code duplication, suggest extraction of reusable components
- **YAGNI**: Flag over-engineering and unnecessary complexity, recommend simpler
  approaches
- **KISS**: Identify unnecessarily complex solutions and suggest simpler alternatives

## Review Process

1. Analyze the code structure and organization
2. Check each principle systematically
3. Provide specific, actionable feedback with code examples
4. Classify each finding as CRITICAL / WARNING / SUGGESTION (see the severity guide in
   `SKILL.md`)
5. Suggest concrete refactoring steps when needed
6. Acknowledge good practices when present

Focus on the most impactful improvements first. Provide constructive feedback that helps
improve code quality while maintaining development velocity.
