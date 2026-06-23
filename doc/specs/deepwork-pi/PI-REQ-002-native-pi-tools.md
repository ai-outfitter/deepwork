# PI-REQ-002: Native Pi Tools

## Overview

The DeepWork Pi package exposes DeepWork runtime capabilities as native Pi tools registered with `pi.registerTool()`. These tools are the primary runtime interface through which Pi agents discover, execute, and manage multi-step workflows; run DeepWork Reviews; inspect configured review rules; mark reviews as passed; and list DeepSchemas. The Pi package MUST NOT expose these capabilities through MCP. It SHOULD reuse the existing DeepWork Python workflow, review, schema, and state-management implementation through a narrow native bridge rather than reimplementing core DeepWork semantics in TypeScript.

## Source Material

This requirement file was copied and adapted from `deep-work/doc/specs/deepwork/jobs/JOBS-REQ-001-mcp-workflow-tools.md`.

## Requirements

### PI-REQ-002.1: Tool Registration and Configuration

1. The extension MUST register native Pi tools during extension initialization.
2. The extension MUST register tools using `pi.registerTool()`.
3. The extension MUST NOT register these tools through MCP.
4. The extension MUST resolve the project root from the active Pi tool context for every tool invocation unless an explicit path parameter is provided by a supported developer-only path.
5. The extension MUST use the active Pi working directory as the default project root.
6. The extension MUST log or surface tool failures with the native tool name, resolved project root or working directory, and underlying error message.
7. The extension SHOULD copy or expose `job.schema.json` to `.deepwork/job.schema.json` under the project root when workflow tools are first used.
8. The extension SHOULD write DeepWork status manifests using the existing DeepWork status writer when workflow tools are used.

### PI-REQ-002.2: Native Implementation Bridge

1. The package MUST provide a centralized implementation bridge for invoking existing DeepWork functionality.
2. The bridge MUST expose typed functions corresponding to every native Pi tool.
3. The bridge MUST NOT require a running MCP server.
4. The bridge MAY invoke a DeepWork CLI JSON command when no stable in-process API exists.
5. If the bridge invokes CLI commands, it MUST parse structured JSON output rather than screen-scraping human-readable text whenever the DeepWork side supports it.
6. If structured JSON output is unavailable, the bridge MUST isolate text parsing to the bridge layer and document the compatibility risk.
7. The bridge SHOULD prefer direct Python module/library calls or a purpose-built JSON CLI surface over shelling out to existing human CLI commands.
8. The bridge MUST cover workflow state operations, finished-step quality gates, review rule matching and pass caching, and named schema discovery with parity tests or handler tests that assert the DeepWork-compatible operation invoked for each native tool.

### PI-REQ-002.3: `deepwork_get_workflows` Tool

1. The extension MUST register a native Pi tool named `deepwork_get_workflows`.
2. The tool MUST accept no user-visible parameters unless required by Pi's tool schema conventions.
3. The tool MUST return an object with a `jobs` key containing a list of job info objects.
4. Each job info object MUST contain `name`, `summary`, and `workflows` fields.
5. Each workflow info object MUST contain `name`, `summary`, and `how_to_invoke` fields.
6. When a workflow's `agent` field is set, `how_to_invoke` MUST contain instructions for delegating to a Pi subagent of the specified type when such a subagent is available.
7. When a workflow's `agent` field is not set, `how_to_invoke` MUST contain instructions to call `deepwork_start_workflow` directly.
8. The tool MUST also return an `errors` key containing a list of job load error objects for jobs that failed to parse.
9. Each job load error object MUST contain `job_name`, `job_dir`, and `error` fields.

### PI-REQ-002.4: `deepwork_start_workflow` Tool

1. The extension MUST register a native Pi tool named `deepwork_start_workflow`.
2. The tool MUST require `goal`, `job_name`, and `workflow_name` string parameters.
3. The tool MUST accept optional `inputs`, `session_id`, and `agent_id` parameters.
4. When `session_id` is omitted, the tool MUST use the active Pi session identifier when available.
5. When neither an explicit nor active Pi session identifier is available, the tool MUST generate a stable fallback session identifier for the current Pi process/session.
6. The tool MUST raise or return a structured tool error if the specified `job_name` does not exist.
7. The tool MUST raise or return a structured tool error if the specified `workflow_name` does not match any workflow, unless the job has exactly one workflow, in which case it is auto-selected.
8. The tool MUST raise or return a structured tool error if the selected workflow has no steps.
9. The tool MUST create a new workflow session through the existing DeepWork state manager semantics.
10. The tool MUST resolve input values for the first step from provided `inputs` and previous step outputs.
11. The tool MUST mark the first step as started with resolved input values.
12. The response MUST contain a `begin_step` object with `session_id`, `step_id`, `project_root`, `job_dir`, `step_expected_outputs`, `step_inputs`, `step_instructions`, and `common_job_info` fields.
13. The `project_root` field MUST be the absolute path used for job discovery and `.deepwork/` operations.
14. The response MUST contain a `stack` field.
15. The response MUST contain an `important_note` field instructing the agent to clarify ambiguous requests.
16. Each expected output MUST include `name`, `type`, `description`, `required`, and `syntax_for_finished_step_tool` fields.

### PI-REQ-002.5: `deepwork_finished_step` Tool

1. The extension MUST register a native Pi tool named `deepwork_finished_step`.
2. The tool MUST require an `outputs` object mapping step output names to values.
3. The tool MUST accept optional `work_summary`, `quality_review_override_reason`, `session_id`, and `agent_id` parameters.
4. When `session_id` is omitted, the tool MUST use the active Pi session identifier or fallback identifier described in PI-REQ-002.4.
5. The tool MUST raise or return a structured tool error if no active workflow session exists for the resolved session identifier.
6. The tool MUST validate submitted outputs against the current step's declared output refs.
7. The tool MUST return a response with `status` equal to `needs_work`, `next_step`, or `workflow_complete`.
8. If `quality_review_override_reason` is not provided, the tool MUST invoke the existing DeepWork quality gate behavior.
9. If `quality_review_override_reason` is provided, the tool MUST skip quality gate evaluation entirely.
10. When the quality gate returns feedback, the tool MUST record a quality attempt and return `status: needs_work` with the feedback.
11. After successful quality gate evaluation or skip, the tool MUST mark the current step as completed with outputs and work summary.
12. If no more steps remain, the tool MUST return `status: workflow_complete` with merged `all_outputs` and any `post_workflow_instructions`.
13. If more steps remain, the tool MUST advance to the next step, resolve its input values, mark it as started, and return `status: next_step` with a `begin_step` object.
14. All responses MUST include a `stack` field.

### PI-REQ-002.6: Output Validation

1. The system MUST reject submitted output keys that do not match any declared output name.
2. The system MUST reject submissions missing any required output.
3. Optional outputs MAY be omitted without error.
4. For outputs with type `file_path`, the value MUST be a string or list of strings.
5. Each submitted file path MUST exist relative to the project root unless the underlying job explicitly allows a different path semantics.
6. For outputs with type `string`, the value MUST be a string.
7. Type mismatches and missing files MUST produce structured tool errors.

### PI-REQ-002.7: `deepwork_abort_workflow` Tool

1. The extension MUST register a native Pi tool named `deepwork_abort_workflow`.
2. The tool MUST require an `explanation` string.
3. The tool MUST accept optional `session_id` and `agent_id` parameters.
4. When `session_id` is omitted, the tool MUST use the active Pi session identifier or fallback identifier described in PI-REQ-002.4.
5. The tool MUST raise or return a structured error if no active workflow session exists.
6. The tool MUST mark the session as aborted and remove it from the workflow stack.
7. The response MUST contain `aborted_workflow`, `aborted_step`, `explanation`, `stack`, `resumed_workflow`, and `resumed_step` fields.

### PI-REQ-002.8: `deepwork_go_to_step` Tool

1. The extension MUST register a native Pi tool named `deepwork_go_to_step`.
2. The tool MUST require a `step_id` string.
3. The tool MUST accept optional `session_id` and `agent_id` parameters.
4. When `session_id` is omitted, the tool MUST use the active Pi session identifier or fallback identifier described in PI-REQ-002.4.
5. The tool MUST raise or return a structured error if no active workflow session exists.
6. The tool MUST raise or return a structured error listing available step names if `step_id` does not exist in the workflow.
7. The tool MUST reject forward navigation and direct the agent to use `deepwork_finished_step` instead.
8. The tool MUST allow navigating to the current step to restart it.
9. The tool MUST collect all step names from the target index through the end of the workflow as invalidated steps.
10. The tool MUST clear session tracking state for all invalidated steps.
11. The tool MUST NOT delete files on disk.
12. The tool MUST mark the target step as started with resolved input values.
13. The response MUST contain `begin_step`, `invalidated_steps`, and `stack` fields.

### PI-REQ-002.9: Native Review Tools

1. The extension MUST register a native Pi tool named `deepwork_get_review_instructions`.
2. The extension MUST register a native Pi tool named `deepwork_get_configured_reviews`.
3. The extension MUST register a native Pi tool named `deepwork_mark_review_as_passed`.
4. Review tools MUST use DeepWork review-rule discovery, matching, instruction generation, and pass-caching semantics.
5. Review tools MUST NOT call MCP tools or require an MCP server.
6. `deepwork_get_review_instructions` MUST accept an optional `files` list.
7. When `files` is omitted, `deepwork_get_review_instructions` MUST detect changed files using DeepWork's changed-file detection semantics.
8. `deepwork_get_review_instructions` MUST return review tasks suitable for Pi-native review dispatch.
9. Each review task MUST include task name, description, reviewer/subagent type when available, and a prompt or prompt file path.
10. `deepwork_get_configured_reviews` MUST accept an optional file filter.
11. `deepwork_get_configured_reviews` MUST return all configured review rules that apply to the requested scope, including DeepSchema-generated review rules.
12. `deepwork_mark_review_as_passed` MUST require a `review_id` string.
13. `deepwork_mark_review_as_passed` MUST mark the review as passed so it is not re-run while reviewed files remain unchanged.
14. `deepwork_get_review_instructions` MUST accept an optional `autostart_reviews_if_possible` boolean that defaults to `true` and controls whether generated review tasks are automatically launched through available native review dispatch.

### PI-REQ-002.10: Native DeepSchema Tools

1. The extension MUST register a native Pi tool named `deepwork_get_named_schemas`.
2. The tool MUST list named DeepSchemas discovered across project-local, standard, and environment-configured schema sources.
3. Each returned schema MUST include name, summary, and matcher patterns.
4. The tool MUST NOT require an MCP server.

### PI-REQ-002.11: Serialization

1. Native Pi tool responses MUST be plain JSON-serializable values.
2. Python/Pydantic model responses MUST be converted to plain objects before being returned to Pi.
3. Enum values in responses MUST be serialized as strings.
4. File paths in responses SHOULD be relative to the project root when intended for user display and absolute when required for tool follow-up.

### PI-REQ-002.12: Issue Detection

1. The native Pi implementation MUST expose DeepWork job issue detection during workflow discovery and workflow startup.
2. Issue detection MUST detect job files that fail schema validation or parsing.
3. Each issue MUST have `severity`, `job_name`, `job_dir`, `message`, and `suggestion` fields.
4. Suggestions for schema errors SHOULD reference `/deepwork repair` or the native Pi repair workflow when available.
5. When issues are detected, workflow tool responses MUST include an `issue_detected` key with formatted warning text.
6. When no issues are detected, workflow tool responses MUST NOT include `issue_detected`.

### PI-REQ-002.13: Tool Naming Compatibility

1. Native Pi tools MUST use the `deepwork_` prefix to avoid collisions with other Pi tools.
2. Tool names SHOULD match the direct DeepWork tool names currently exposed in Pi where practical.
3. The package MAY provide compatibility aliases only when Pi supports aliases without ambiguity.
4. Documentation MUST distinguish native Pi tools from MCP tools.

### PI-REQ-002.14: Native Session Job Tools

1. The extension MUST register a native Pi tool named `deepwork_register_session_job`.
2. The extension MUST register a native Pi tool named `deepwork_get_session_job`.
3. `deepwork_register_session_job` MUST accept `job_name`, `job_definition_yaml`, optional `session_id`, and optional `agent_id` parameters.
4. `deepwork_register_session_job` MUST validate `job_name` against `^[a-z][a-z0-9_]*$`.
5. `deepwork_register_session_job` MUST validate YAML syntax and the DeepWork job schema before reporting success.
6. `deepwork_register_session_job` MUST write the submitted job file to session-scoped on-disk storage so validation failures remain inspectable.
7. `deepwork_register_session_job` MUST require the YAML `name` field to match the registered `job_name`.
8. `deepwork_get_session_job` MUST accept `job_name`, optional `session_id`, and optional `agent_id` parameters.
9. `deepwork_get_session_job` MUST return the registered job YAML for the resolved Pi session.
10. Session jobs MUST be discoverable by `deepwork_start_workflow`, `deepwork_finished_step`, `deepwork_abort_workflow`, `deepwork_go_to_step`, and `deepwork_get_workflows` for the same resolved Pi session.
11. Session jobs MUST take priority over project-local, standard, and additional job folders with the same job name.
12. A session job registered under one resolved `session_id` MUST NOT be discoverable under another resolved `session_id`.
