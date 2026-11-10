---
description: Show final output for a finished OpenCode job, including session ID for resuming
argument-hint: '[job-id-prefix]'
disable-model-invocation: true
allowed-tools: Bash(sh:*)
---

Run the result command and return output verbatim. Replace `<repo>` with the absolute path of the repository the user is working in (a job ID is found in any workspace; without an ID the latest finished job of this workspace is shown).

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" result --cwd "<repo>" $ARGUMENTS
```

- Do not fix any issues mentioned in the result output.
