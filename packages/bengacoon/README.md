# Bengacoon workflow

This private workspace package contains the workflow resources built into `bengacoon-cli`:

- background read-only jobs and `/jobs`;
- the Syra orchestration rules, skills, prompts, and review gate;
- personal model assignments through `/syra-models`.

The coding-agent build copies this package into its distributable assets. The CLI loads the two extensions plus the skill and prompt directories by default, without adding package entries to user or project settings.

Runtime state belongs under the Bengacoon agent directory (`~/.bengacoon/agent` by default). No credentials, sessions, local profile state, review receipts, or Git metadata are part of this package.

## Checks

```bash
npm run check -w @bengacoon/workflow
```

The paid child-process conformance check remains explicit:

```bash
node packages/bengacoon/scripts/conformance-checks.mjs
```
