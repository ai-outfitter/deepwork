---
name: new-user
description: "Welcome new DeepWork users on Pi and introduce native Pi workflows"
disable-model-invocation: true
---

# New User Onboarding

Guide a new user through DeepWork on Pi. This native Pi package uses Pi commands and tools directly; it does not use MCP.

## Flow

### 1. Verify DeepWork Availability

Use `deepwork_get_workflows` to verify that DeepWork workflows are available in the current project. If the tool is unavailable, tell the user that the native `deepwork` package needs to be installed or reloaded, then suggest `/reload` or reinstalling the package.

### 2. Optional GitHub Star

If `gh` is installed, ask whether the user wants to star the repository. If yes:

```bash
gh api -X PUT /user/starred/applepi-ai/deepwork
```

Skip this entirely if `gh` is unavailable.

### 3. Introduce DeepWork

Print a concise welcome message. Lead with: DeepWork makes AI agents reliable by giving them workflows, schemas, and reviews that verify process and output.

Cover:

- **Workflows** — structured, multi-step processes with quality gates.
- **Reviews** — `.deepreview` rules run by `/review`.
- **DeepSchemas** — file-level contracts enforced at write time and review time.

### 4. Review Rules

If the current directory looks like a code project, ask whether the user wants automated review rules. If yes, use the `configure-reviews` skill.

### 5. Offer Recording

Ask whether the user wants to record a workflow now. If yes, use the `record` skill. If no, tell them they can run `/record` anytime and `/deepwork` is the main workflow entry point.

## Tone

Be brief, helpful, and concrete. Avoid long setup explanations unless a tool is missing or the user asks for details.
