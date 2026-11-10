---
description: Cancel an active background OpenCode job
argument-hint: '[job-id-prefix]'
disable-model-invocation: true
allowed-tools: Bash(sh:*)
---

Run the cancel command and return output verbatim. Replace `<repo>` with the absolute path of the repository the user is working in (a job ID is found in any workspace, but cancel without an ID uses this one).

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" cancel --cwd "<repo>" $ARGUMENTS
```
