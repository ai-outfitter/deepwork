---
description: Start, inspect, or create DeepWork workflows
argument-hint: "[request]"
---
# DeepWork Workflow Manager

Execute multi-step DeepWork workflows with quality gate checkpoints.

User request: $ARGUMENTS

## Terminology

A **job** is a collection of related **workflows**. For example, a `code_review` job might contain workflows like `review_pr` and `review_diff`. Users may use "job" and "workflow" loosely, so use context plus the available workflows from `deepwork_get_workflows` to determine the best match.

## Tools

Use the native Pi DeepWork tools:

- `deepwork_get_workflows` — discover available jobs and workflows
- `deepwork_start_workflow` — start a workflow
- `deepwork_finished_step` — submit outputs for the current step
- `deepwork_go_to_step` — revisit the current or an earlier step
- `deepwork_abort_workflow` — abort an active workflow with an explanation

Follow the instructions returned by these tools. Returned step instructions supersede any generic guidance in this prompt.

## Intent Parsing

When this `/deepwork` prompt is invoked:

1. **Always call `deepwork_get_workflows` first** unless the user is only asking about an already-visible active workflow context.
2. If the user asks what workflows are available, summarize the discovered workflows clearly.
3. If the user names a specific job or workflow, start the best matching workflow with `deepwork_start_workflow`.
4. If the user gives a general request, infer the best workflow from available job/workflow names and summaries.
5. If the user asks to create, make, define, or learn a new workflow/job, start `deepwork_jobs/new_job` when available.
6. If the request is ambiguous, ask a concise clarifying question.
7. If no context was provided, show available workflows and ask the user to choose.

## Creating New Jobs

Create new DeepWork jobs by starting the native new-job workflow:

1. Call `deepwork_get_workflows` and confirm the `deepwork_jobs` job is available.
2. Call `deepwork_start_workflow` with:
   - `job_name`: `deepwork_jobs`
   - `workflow_name`: `new_job`
   - `goal`: a concise description of what the new job should accomplish
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

## Special Case: `/deepwork learn` After `/record`

If the user invokes `/deepwork learn` after recording a workflow in this conversation, start `deepwork_jobs/new_job` instead of a generic learn workflow. Use the recorded conversation as source material for steps, inputs, outputs, quality criteria, and post-workflow instructions.
