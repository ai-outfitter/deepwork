# PI-REQ-003: Native Pi Review Instructions

## Overview

DeepWork Reviews in Pi generate self-contained review tasks and markdown instruction files that Pi agents or Pi subagents can execute. The native Pi extension MUST preserve DeepWork review semantics while formatting prompts for Pi rather than Claude Code or MCP. Instruction files are written under `.deepwork/tmp/review_instructions/` and referenced by native Pi review tools and commands.

## Source Material

This requirement file was copied and adapted from `deep-work/doc/specs/deepwork/review/REVIEW-REQ-005-instruction-generation.md`.

## Requirements

### PI-REQ-003.1: Instruction File Content

1. Each instruction file MUST be a valid markdown document.
2. The file MUST begin with a heading identifying the review rule and scope, such as `# Review: python_file_best_practices — src/app.py`.
3. The file MUST contain a `Review Instructions` section with the rule's resolved instruction text.
4. The file MUST contain a `Project Root` section near the top.
5. The `Project Root` section MUST state the absolute path of the project root against which all relative paths in the document are resolved.
6. The `Project Root` section MUST instruct Pi reviewers to read files from that project root, even when their current working directory differs.
7. The file MUST contain a `Files to Review` section listing the file paths to examine when the task has at least one file to review.
8. File paths in the `Files to Review` section MUST be relative to the repository root.
9. When the task has `additional_files`, the file MUST contain an `Unchanged Matching Files` section listing those file paths.
10. When the task has `all_changed_filenames`, the file MUST contain an `All Changed Files` section listing every changed filename for context.
11. When the task has `inline_content` set, the file MUST contain a `Content to Review` section whose body is the inline content verbatim.
12. Inline-content tasks MUST NOT include a `Files to Review` section.
13. The review heading scope MUST read `inline content` when the task has `inline_content` and no files to review.

### PI-REQ-003.2: Pi File Path Formatting

1. File paths in review instruction files MUST be usable by Pi agents.
2. File paths in `Files to Review` SHOULD be rendered as plain relative paths unless Pi supports a documented file-reference syntax that is more reliable.
3. File paths in `Unchanged Matching Files` SHOULD be rendered as plain relative paths unless Pi supports a documented file-reference syntax that is more reliable.
4. File paths in `All Changed Files` MUST be rendered for informational context only.
5. The Pi renderer MUST NOT rely on Claude Code-specific `@path` auto-read behavior.
6. The instruction text MUST explicitly tell the reviewer to use Pi's file-reading tools to inspect listed files.

### PI-REQ-003.3: File Writing

1. Instruction files MUST be written to `.deepwork/tmp/review_instructions/` under the project root.
2. The directory MUST be created if it does not exist.
3. Each instruction file MUST have a unique filename with a `.md` extension.
4. Filenames MUST be deterministic and based on the review ID when a review ID is available.
5. The implementation MUST use DeepWork's safe file-writing utility or an equivalent atomic safe-write operation.
6. The review implementation MUST return a list of task-to-instruction-file mappings.
7. The returned instruction file paths MUST be suitable for Pi subagents or the parent Pi agent to read.

### PI-REQ-003.4: Instruction Resolution

1. When a rule's instructions reference a file, the system MUST resolve the path relative to the rule's source directory.
2. Resolved instruction text MUST be included verbatim in the instruction file.
3. If the referenced file cannot be read, the system MUST raise or return a structured error with the file path and reason.
4. The native Pi extension MUST preserve existing DeepWork instruction resolution semantics.

### PI-REQ-003.5: Cleanup

1. The system SHOULD clear `.deepwork/tmp/review_instructions/` at the start of each native Pi review generation run.
2. The system MUST NOT delete review instruction files that are currently referenced by an in-progress review unless a new review generation run is replacing them.

### PI-REQ-003.6: Policy Traceability

1. Each instruction file MUST end with a traceability line linking back to the source `.deepreview` file and rule location when that location is available.
2. The traceability line MUST be formatted as: `This review was requested by the policy at \`{source_location}\`.`
3. The traceability line MUST be preceded by a markdown horizontal rule.
4. When `source_location` is empty, the traceability section MUST be omitted.

### PI-REQ-003.7: Precomputed Context Section

1. When a task has precomputed info, the instruction file MUST contain a `Precomputed Context` section.
2. The `Precomputed Context` section MUST be the last content section before the `After Review` section.
3. The section MUST contain the verbatim stdout of the precomputed command.
4. When the command failed, the section MUST contain an error message with stderr and exit code.
5. Precomputed commands MUST run under the resolved project root unless a rule explicitly defines another safe working directory.

### PI-REQ-003.8: Relevant File Contents Section

1. When a task's `reference_files` list is empty, the instruction file MUST NOT contain a `Relevant File Contents` section.
2. When a task has reference files, the instruction file MUST contain a `Relevant File Contents` section between `Review Instructions` and `Files to Review`.
3. Each inlined file MUST be rendered with a subheading containing a relative label, any optional description, and file contents inside a fenced code block.
4. The code fence language SHOULD be inferred from the file extension.
5. The number of inlined reference files MUST NOT exceed DeepWork's configured inline file count limit.
6. The total inlined byte size of reference file contents MUST NOT exceed DeepWork's configured inline byte limit.
7. When a referenced file cannot be read, the system MUST emit a graceful marker line with the file path and error.
8. Reference file entries beyond the count cap MUST be listed in an omitted summary line.
9. When a referenced file would exceed the remaining byte budget, the file MUST be truncated with a visible truncation marker.
10. Reference file entries that cannot be inlined because the byte budget was exhausted MUST be reported in the omitted summary line.
11. Unreadable reference files MUST NOT abort rendering of the `Relevant File Contents` section.
12. Unreadable reference files MUST NOT count against the total byte budget.

### PI-REQ-003.9: After Review Instructions

1. Each instruction file MUST include an `After Review` section.
2. The `After Review` section MUST instruct the reviewer to report findings with file paths and line references when possible.
3. The `After Review` section MUST instruct the reviewer to call `deepwork_mark_review_as_passed` with the review ID when the review passes.
4. The `After Review` section MUST instruct the reviewer not to mark a review as passed when actionable findings remain.
5. The `After Review` section MUST use native Pi tool names and MUST NOT mention MCP tool names.

### PI-REQ-003.10: Review Task Shape for Pi

1. Native Pi review generation MUST return review tasks in a structured JSON-serializable shape.
2. Each task MUST include `name`, `description`, `prompt_file`, and `review_id` fields when available.
3. Each task SHOULD include `subagent_type` or `reviewer` when a rule requests a specific reviewer persona.
4. If no reviewer persona is specified, the task SHOULD default to a Pi-compatible reviewer subagent when available.
5. The task prompt MUST instruct the reviewer to read the `prompt_file` and follow it exactly.
6. The task prompt MUST instruct the reviewer not to edit files unless the review strategy explicitly permits edits.

### PI-REQ-003.11: Native Review Dispatch

1. The `/review` command MUST call native Pi review generation before dispatching reviewers.
2. When Pi subagents are available, the command SHOULD dispatch independent review tasks in parallel.
3. When Pi subagents are unavailable, the command MUST provide a sequential fallback that the parent agent can execute.
4. Dispatch prompts MUST reference native Pi tools and file-reading behavior.
5. Dispatch prompts MUST NOT instruct reviewers to call MCP tools.

### PI-REQ-003.12: RFC 2119 Language

1. Requirement files in `deepwork/doc/specs/` MUST use RFC 2119 keywords consistently.
2. Normative statements MUST use uppercase `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`, or `SHALL`.
3. Non-normative explanatory text SHOULD avoid lowercase normative keywords when those words could be interpreted as requirements.
4. Each numbered requirement MUST be testable or reviewable.
