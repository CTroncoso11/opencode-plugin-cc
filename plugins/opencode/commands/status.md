---
description: Show running and recent OpenCode jobs for the current repository
argument-hint: '[job-id-prefix] [--all]'
disable-model-invocation: true
allowed-tools: Bash(sh:*)
---

Run the status command and return output verbatim. Replace `<repo>` with the absolute path of the repository the user is working in.

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" status --cwd "<repo>" $ARGUMENTS
```
