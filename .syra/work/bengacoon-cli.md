# Bengacoon CLI

- [x] rebrand the CLI and isolate its profile
      done: invoking `bengacoon --version` identifies Bengacoon and resolves profile state under `~/.bengacoon/agent`, while an installed `pi` continues using its existing profile

- [x] ship the Bengacoon workflow as a built-in package
      done: a clean Bengacoon profile starts with the packaged workflow, skills, jobs, and model-assignment command available without installing another package

- [x] add a structural sidebar slot to fullscreen layout
      done: at 120 terminal columns or wider, a 36-column right sidebar is reserved and transcript lines never enter it; below 120 columns the transcript uses the full width and the sidebar slot is absent

- [ ] provide the Bengacoon status snapshot
      done: one snapshot reports Git branch, session input/output tokens and cost, remaining context, job totals plus active/failed job details, and daily/weekly Codex quota when response headers provide it or `Unavailable` otherwise

- [ ] render the status responsively
      done: the snapshot renders in the 36-column sidebar at 120 columns or wider and as a readable multi-line footer below 120 columns, updating when branch, jobs, usage, context, or available quota changes
