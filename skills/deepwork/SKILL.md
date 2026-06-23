---
name: deepwork
description: "Start or continue DeepWork workflows using native Pi tools"
---

# DeepWork Workflow Manager

Use DeepWork to run structured, multi-step workflows with quality gates. This native Pi package uses Pi commands and tools directly; it does not use MCP.

## Terminology

A **job** is a collection of related **workflows**. For example, a `code_review` job might contain workflows like `review_pr` and `review_diff`. Users may use "job" and "workflow" loosely, so use context plus `deepwork_get_workflows` to choose the best match.

## Native Pi Tools

Use these tools for workflow operations:

- `deepwork_get_workflows` — discover available jobs and workflows
- `deepwork_register_session_job` — register a transient job for the current Pi session
- `deepwork_get_session_job` — retrieve a transient job registered for the current Pi session
- `deepwork_start_workflow` — start a workflow
- `deepwork_finished_step` — submit outputs for the current step
- `deepwork_go_to_step` — revisit the current or an earlier step
- `deepwork_abort_workflow` — abort an active workflow with an explanation

Follow the instructions returned by the tools. Returned step instructions supersede any generic guidance in this skill.

## How to Use

1. Call `deepwork_get_workflows` to discover available workflows.
2. Call `deepwork_start_workflow` with `goal`, `job_name`, and `workflow_name`.
3. Follow the returned `begin_step.step_instructions`.
4. Use the returned `begin_step.session_id` for follow-up calls when provided.
5. Create all required outputs before calling `deepwork_finished_step`.
6. Handle the response status:
   - `needs_work` — address feedback, then call `deepwork_finished_step` again.
   - `next_step` — continue with the returned `begin_step`.
   - `workflow_complete` — summarize the completed workflow and outputs.

## Creating New Jobs

Create new DeepWork jobs by starting the native new-job workflow:

1. Call `deepwork_get_workflows` and confirm the `deepwork_jobs` job is available.
2. Call `deepwork_start_workflow` with:
   - `job_name`: `deepwork_jobs`
   - `workflow_name`: `new_job`
   - `goal`: a concise description of the workflow the user wants to create
3. Follow the returned step instructions until completion.

## Quality Gates

Some steps have quality criteria. When `deepwork_finished_step` runs:

- Outputs are checked against review criteria.
- Failed criteria return `needs_work` with feedback.
- Passing criteria advance to the next step or complete the workflow.

Do not override a quality gate unless the user explicitly authorizes the override and you provide a clear `quality_review_override_reason`.

## Nested Workflows and Navigation

- Starting a workflow while another is active pushes onto the workflow stack.
- Use `deepwork_abort_workflow` when a workflow cannot be completed.
- Use `deepwork_go_to_step` only for the current or an earlier step. It invalidates progress from that step onward, but it does not delete files.

## Intent Parsing for `/deepwork`

When the user invokes `/deepwork`:

1. Always discover workflows with `deepwork_get_workflows`.
2. If the user names a workflow, start the best matching workflow.
3. If the user gives a general request, infer the best workflow from available jobs and summaries.
4. If the request is ambiguous, ask a short clarifying question.
5. If `/deepwork` has no additional context, show available workflows and ask the user to choose.

## Special Case: `/deepwork learn` After `/record`

If the user invokes `/deepwork learn` after recording a workflow in this conversation, start `deepwork_jobs/new_job` instead of a generic learn workflow. Use the recorded conversation as the source material for steps, inputs, outputs, quality criteria, and post-workflow instructions.
