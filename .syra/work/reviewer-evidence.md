# Reviewer evidence

- [ ] execute selected reviewers in isolated read-only Pi processes
      done: a reviewer process receives the frozen staged diff and its fixed checklist, returns its raw result, and cannot modify the target worktree

- [ ] derive review receipts from reviewer executions
      done: review-gate record rejects raw verdict text without evidence and records each selected reviewer's execution result against the frozen diff

- [ ] surface receipt-backed reviewer status
      done: a completed reviewer card shows matches, missing, or stale from the current staged receipt without treating the card itself as commit authority
