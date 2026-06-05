---
name: deepplan
description: "Start structured planning that produces an executable DeepWork plan"
---

# DeepPlan

DeepPlan is a structured planning workflow that explores the codebase, compares implementation approaches, and produces an executable DeepWork job or plan. This native Pi package uses Pi tools directly; it does not use MCP.

## How to Use

1. Clarify the planning goal if the user request is ambiguous.
2. Call `deepwork_start_workflow` with:
   - `job_name`: `deepplan`
   - `workflow_name`: `create_deep_plan`
   - `goal`: the user's planning request
3. Follow the returned step instructions exactly.
4. Submit required outputs with `deepwork_finished_step`.
5. Continue until the workflow completes or the user explicitly stops.

## Intent Parsing for `/deepplan`

- `/deepplan <goal>` — start the DeepPlan workflow using `<goal>`.
- `/deepplan` with useful conversation context — summarize the context as the goal and start the workflow.
- `/deepplan` without enough context — ask what the user wants to plan.

## Planning Discipline

- Keep exploration proportional to the scope.
- Capture assumptions and open questions explicitly.
- Prefer implementation-ready plans with file targets, validation commands, and risk notes.
- If planning discovers that requirements are unclear, pause and ask the user rather than inventing product behavior.
