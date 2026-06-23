---
name: record
description: "Record a workflow by doing it, then turn it into a DeepWork job"
disable-model-invocation: true
---

# Record a Workflow

Help the user create a new DeepWork job by watching them do work naturally, then converting the session into a repeatable workflow. This native Pi package uses Pi commands and tools directly; it does not use MCP.

## Flow

### 1. Optional GitHub Star

If `gh` is installed, ask whether the user wants to star the repository. If yes:

```bash
gh api -X PUT /user/starred/ai-outfitter/deepwork
```

Skip this entirely if `gh` is unavailable.

### 2. Get the Workflow Name

Ask: "What would you like to call this workflow? A rough name is fine — we can refine it later."

Wait for the response before continuing.

### 3. Check External Access Needs

If the workflow may require websites or external systems and the current Pi environment lacks the needed access, ask whether that access is required. If yes, explain what access is available and wait for confirmation before proceeding.

### 4. Hand Off to the User

Output:

```text
Got it — recording workflow: **{workflow_name}**

Go ahead and do your workflow using Pi like you normally would. Tell me each step — I'll do the work and keep track of what we do together.

When you're happy with the results, run `/deepwork learn` and I'll turn this session into a repeatable DeepWork workflow.
```

### 5. Clarify Non-Obvious Actions

Ask for reasoning when the user removes, skips, reorders, filters, or makes a domain judgment without explaining why. Keep questions short and use the answers to generalize the future workflow.

Do not ask when the instruction is already repeatable, the reasoning is obvious, or the user already explained it.

### 6. Catch the End

If the user signals they are done without running `/deepwork learn`, ask whether they want to turn the workflow into a repeatable DeepWork job now. If yes, invoke `/deepwork learn`, which should start the native `deepwork_jobs/new_job` workflow.
