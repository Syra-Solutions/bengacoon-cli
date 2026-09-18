# Delivery continuity

- [x] persist active delivery state locally
      done: after restarting a session in the same worktree, the sidebar restores the active delivery item, reported verification, and next step without requiring the workflow to report it again

- [x] mirror delivery state to Engram when available
      done: when the configured Engram tools are available, the workflow stores the current delivery context under a project-scoped stable key and continues normally when they are unavailable

- [x] prevent mirrored state from authorizing delivery
      done: a restored delivery card reads receipt status from the current staged Git diff and never treats an Engram record as a valid receipt
