# Delivery observability

- [x] show the active delivery unit in the sidebar
      done: when the workflow reports an unfinished Bengacoon work item, the sidebar renders its acceptance criterion, reported verification state, receipt state, and next incomplete step

- [ ] attribute session changes and expose their diff
      done: a successful write or edit from the current session appears in the sidebar with its path and line delta, and the user can open a bounded diff without scanning unrelated repository changes

- [ ] reconcile reviewer cards with the staged receipt
      done: a completed reviewer card shows receipt missing when no matching receipt exists and stale when the staged diff changes after its recorded review, while the hook remains the sole commit authority
