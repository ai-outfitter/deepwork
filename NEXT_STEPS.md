# DeepWork Pi Next Steps

## Current State

`deepwork/` now contains a first-pass native Pi package:

- Pi package manifest and TypeScript config.
- Native Pi extension entry point.
- Native `deepwork_*` tool registrations.
- `/deepwork`, `/review`, and `/deepwork_review` commands.
- Session context restoration, commit review reminders, and DeepSchema write feedback hooks.
- Native Pi skills and review reference docs.
- Requirements docs under `doc/specs/deepwork/`.

The package is intentionally Pi-native at the interface boundary: it does not require `.mcp.json`, does not register MCP direct tools, and does not start a DeepWork MCP server.

Current validation status: `npm run check:package`, `npm run typecheck`, and `npm test` pass. The test suite currently has 18 files and 117 tests. Latest local validation on 2026-05-15 passed all three commands.

`deepwork_get_workflows` now uses native TypeScript workflow discovery and parsing in `src/workflows/discovery.ts`. Basic workflow runtime operations now use native TypeScript in `src/workflows/runtime.ts`, `src/workflows/state.ts`, `src/workflows/status.ts`, `src/workflows/output-validation.ts`, and `src/workflows/quality-gates.ts` for start, finish, abort, backwards/current-step navigation, nested stack push/pop, native state persistence, status manifest writing, active-stack context restoration, output validation, quality-gate override, JSON-schema checks for file outputs, dynamic workflow-output review task generation, process-requirement quality tasks, and pass-marker suppression for native quality tasks. The package also has a Vitest suite with requirement-traceability comments (`PI-REQ-*`) covering package layout, extension/tool registration, skills, key native-boundary checks, workflow discovery/parsing, golden `getWorkflows` outputs, workflow runtime compatibility goldens, workflow-runtime edge cases, native quality-gate pass/fail/override/parity cases, and first-pass native `.deepreview` parsing/matching. Review instruction generation and configured-review listing now use first-pass native TypeScript paths in `src/reviews/tools.ts` and `src/reviews/instructions.ts`, with Python fallback still available for compatibility. Native review pass-cache tests now cover unchanged suppression and content-change invalidation for deterministic content-addressed review IDs. The `/deepwork` command now supports `status`, lists workflows with issue warnings, starts explicit `/deepwork <job>/<workflow>` selections, auto-starts unambiguous job/workflow requests, prompts with clear native-Pi guidance for ambiguous or missing selections, and routes `/deepwork learn` to `deepwork_jobs/new_job` when available with native draft-job fallback guidance. The `/record` command is now registered and loads/summarizes the record skill to start a native Pi recording flow, ask for a workflow name when needed, capture repeatable-process guidance, and point users back to `/deepwork learn`. The `/review` and `/deepwork_review` commands now pass command-argument file filters to native review generation, show a concise matched-task/reviewer summary before dispatch, include structured task metadata such as `review_id` and files-to-review in summaries/prompts when available, use clearer sequential fallback wording, provide first-pass completion-loop guidance for safe fixes/user confirmation/re-running `/review`, and have mocked Pi-extension tests for no-task, sequential, and subagent-spawn aggregation behavior. The `/configure-reviews` command is now registered and provides first-pass native Pi guidance by loading the configure-reviews skill, scanning existing `.deepreview` files, listing configured reviews, and optionally previewing review instruction generation for file filters. Native review generation now covers `.deepreview` rules plus first-pass DeepSchema-generated review rules from `src/deepschema/discovery.ts` and `src/deepschema/reviews.ts`, including named and anonymous schemas. Native `deepwork_get_named_schemas` now lists project-local, standard, and additional named schemas through `src/deepschema/tools.ts`. DeepSchema write/edit hook feedback now has a first-pass native implementation in `src/deepschema/write-hook.ts` for matching named/anonymous schemas, surfacing requirements/instructions/references/examples, validating `json_schema_path` rules, and executing `verification_bash_command` checks with timeout/error reporting. Pi extension `tool_result` event handling now has requirement-traceable tests for native DeepSchema write/edit augmentation and git-commit review reminders. Commit review reminders now inspect the exact files in the successful `HEAD` commit, filter review rules to those files, exclude pure catch-all rules, skip already-passed review IDs when practical, and ignore failed commit commands. Python fallback remains available for DeepSchema write feedback if the native path throws, unless `DEEPWORK_PI_DISABLE_DEEPSCHEMA_PYTHON_FALLBACK=1` is set. `.deepreview` quality-gate integration and DeepSchema-generated quality-gate rules now have first-pass native support for workflow `file_path` outputs: matching policy rules generate Pi-native review prompts, pass markers suppress already-passed tasks, and `finished_step` stays on `needs_work` until required reviews pass. Real-ish end-to-end native workflow tests now cover repeated `deepwork_finished_step` calls with pass markers, multi-step workflows with early quality gates, status/context restoration after quality-gated advancement, and grouped policy quality gates across multiple output files. Some full review parity details still use `src/bridge.ts`/Python or are not yet native. Some Python modules live in packages named `deepwork.jobs.mcp` or `deepwork.review.mcp`; they are reused for fallback behavior, not exposed as MCP to Pi. This is acceptable only as a temporary bootstrap bridge.

## Primary Goal: Replace Python Bridge with TypeScript

The biggest remaining task is replacing the Python bridge with native TypeScript implementation code.

### Why This Matters

1. A native Pi package SHOULD be installable and runnable as a normal Pi/Node package without Python subprocess startup on every tool call.
2. Runtime behavior SHOULD NOT depend on `uvx`, Python environment resolution, or installed Python package versions.
3. Tool latency SHOULD improve by avoiding one Python process per operation.
4. The codebase SHOULD avoid importing modules whose names imply MCP-specific coupling.
5. Pi-specific behavior SHOULD be first-class instead of adapted from Claude/Codex/MCP-oriented paths.

### Proposed TypeScript Migration Strategy

Do this incrementally, preserving behavior with tests at each stage.

#### Phase 1: Define TypeScript Domain Models — partially complete

Create TypeScript equivalents for the DeepWork data models used by Pi tools:

- Job manifests and workflows.
- Step definitions, inputs, outputs, and output refs.
- Active workflow session state.
- Tool response shapes.
- Review rules, review tasks, review IDs, and pass-cache records.
- DeepSchema manifests and matcher definitions.
- Quality-gate responses.

Suggested files:

- `deepwork/src/types/workflows.ts`
- `deepwork/src/types/reviews.ts`
- `deepwork/src/types/deepschema.ts`
- `deepwork/src/types/common.ts`

Success criteria:

- TypeScript models cover every field currently returned by native tools.
- JSON serialization produces stable plain objects.
- Existing bridge responses can be validated or normalized into these models.

#### Phase 2: Port Workflow Discovery and Parsing — first pass complete

Implement native TypeScript workflow discovery:

- Locate `.deepwork/jobs/**/job.yml` files.
- Parse YAML job files.
- Validate against the DeepWork job schema.
- Load step instruction markdown files.
- Build `deepwork_get_workflows` responses.
- Detect and report job-load issues.
- Copy or expose `job.schema.json` into `.deepwork/job.schema.json`.

Suggested files:

- `deepwork/src/workflows/discovery.ts`
- `deepwork/src/workflows/schema.ts`
- `deepwork/src/workflows/issues.ts`

Success criteria:

- `deepwork_get_workflows` no longer calls Python. ✅
- Output matches Python DeepWork behavior for existing fixture jobs. ✅
- Malformed jobs return useful errors and issue warnings. ✅
- Requirement-commented tests cover discovery ordering, additional job folders, schema copy, parser defaults, parser validation failures, issue warnings, and non-MCP invocation text. ✅
- Remaining follow-up: package or configure standard built-in jobs explicitly instead of relying on the adjacent `deep-work` checkout fallback during development.

#### Phase 3: Port Workflow State Management — first pass complete

Implement native TypeScript workflow session state:

- Active stack per Pi session ID and optional agent ID.
- Start workflow.
- Finish step.
- Abort workflow.
- Go back to current or previous step.
- Resolve inputs from provided values and prior outputs.
- Persist state under `.deepwork/` in a format compatible with or intentionally migrated from current DeepWork state.
- Write status manifests for context restoration.

Suggested files:

- `deepwork/src/workflows/state.ts`
- `deepwork/src/workflows/runtime.ts`
- `deepwork/src/workflows/status.ts`

Success criteria:

- `deepwork_start_workflow`, `deepwork_finished_step` with `quality_review_override_reason`, `deepwork_abort_workflow`, and `deepwork_go_to_step` backwards/current-step paths no longer call Python for basic progression. ✅
- Runtime compatibility goldens pass against the native TypeScript implementation for start, finish-next, finish-complete, abort, go-to-step-back, missing job, no active session, unknown output, and forward navigation errors. ✅
- Native runtime edge tests cover fallback session IDs, state persistence, status/context restoration, optional outputs, required-output errors, file-path outputs, type mismatches, no-step workflow rejection, single-workflow auto-selection, and nested stack abort/resume behavior. ✅
- Active workflow context restoration is now native and no longer shells out to `uvx deepwork jobs get-stack`. ✅
- Real-ish native end-to-end workflow tests now cover multi-step advancement after quality-gate pass markers and status/context restoration. ✅
- Existing real project workflows like `news_summary/daily_brief` still need manual Pi-session validation on the native runtime.

#### Phase 4: Port Output Validation and Quality Gates — partially complete

Implement native output validation and quality-gate handling:

- Required and optional outputs.
- `file_path` existence checks.
- `string` type checks.
- Quality review generation for step outputs.
- JSON Schema validation for file outputs with `json_schema`.
- `needs_work`, `next_step`, and `workflow_complete` statuses.
- Override handling through `quality_review_override_reason`.

Suggested files:

- `deepwork/src/workflows/output-validation.ts`
- `deepwork/src/workflows/quality-gates.ts`

Success criteria:

- Basic output validation exists for unknown outputs, missing required outputs, optional outputs, string outputs, and file-path existence/type checks. ✅
- Quality-gate override flow is implemented for native `finishedStep`. ✅
- Native no-review quality-gate pass flow advances to `next_step` or `workflow_complete` without Python. ✅
- Native workflow-output review gates return `status: needs_work`, write Pi-native instruction files under `.deepwork/tmp/review_instructions/`, and keep the workflow on the current step. ✅
- Native JSON Schema validation for `file_path` outputs returns `status: needs_work` with actionable schema feedback. ✅
- Requirement-traceable tests cover optional outputs, missing required outputs, file-path outputs, missing files, type mismatches, quality-gate pass, review-required failure, override, and schema failure. ✅
- Native quality-gate parity tests now cover output-ref plus step_argument review ordering/naming, file_path output review instruction content, process-requirement quality tasks, unchanged-matching-file context, all-changed-filenames context, precomputed context, deterministic review IDs shared with native review instruction generation for policy gates, and pass-marker suppression across repeated `deepwork_finished_step` calls. ✅
- Native quality gates now include first-pass `.deepreview` rule matching and DeepSchema-generated synthetic review rules for workflow `file_path` outputs. ✅
- Requirement-traceable tests cover `.deepreview` policy quality gates, DeepSchema-generated quality gates, pass-marker suppression, `needs_work`, `next_step`, and `workflow_complete` behavior. ✅
- Real-ish native end-to-end tests now cover repeated `finishedStep` pass-marker suppression, multi-step early quality gates, status/context restoration after quality-gated advancement, and grouped `individual`, `matches_together`, and `all_changed_files` policy gates across multiple output files. ✅
- Compatibility note: policy quality-gate review IDs are intentionally shared with native review instruction generation. Built-in workflow-output and process-requirement quality review IDs do not currently exactly match Python's standard review ID format; they are deterministic and stable for native pass markers, and requirement-traceable tests now document that built-in pass markers suppress unchanged outputs but invalidate when inline output content changes. Exact Python marker compatibility has not been required yet and remains a documented parity gap.
- Remaining follow-up: native quality gates still need deeper parity for exact Python pass-cache semantics beyond native content-change invalidation, built-in workflow-output task ID formatting, process-requirement ID compatibility if required, and real project validation.

#### Phase 5: Port Review Rule Discovery and Task Generation — started

Implement DeepWork Reviews natively in TypeScript:

- Discover `.deepreview` files. ✅ first pass in `src/reviews/config.ts`
- Parse and validate review configs. ✅ first pass in `src/reviews/config.ts`
- Match rules against explicit file lists. ✅ first pass in `src/reviews/matching.ts`
- Detect changed files from git. ✅ first pass in `src/reviews/git.ts`
- Match review strategies (`individual`, `matches_together`, `all_changed_files`). ✅ first pass in `src/reviews/matching.ts`
- Include DeepSchema-generated synthetic rules. ✅ first pass for named and anonymous schemas in `src/deepschema/reviews.ts`
- Generate deterministic review IDs.
- Write review instruction files under `.deepwork/tmp/review_instructions/`. ✅ first pass in `src/reviews/instructions.ts`
- Implement pass caching for native review generation. ✅ first pass skips `.passed` markers written by native `deepwork_mark_review_as_passed`
- Provide a Pi-native review instruction renderer instead of falling back to Codex. ✅ first pass wired into `deepwork_get_review_instructions`

Suggested files:

- `deepwork/src/reviews/config.ts`
- `deepwork/src/reviews/matching.ts`
- `deepwork/src/reviews/instructions.ts`
- `deepwork/src/reviews/pass-cache.ts`
- `deepwork/src/reviews/git.ts`

Success criteria:

- Native `.deepreview` discovery/parsing/matching tests exist for deepest-first discovery, file-reference instruction resolution, schema errors, explicit file filters, include/exclude glob behavior, all three match strategies, and git changed-file detection. ✅
- `deepwork_mark_review_as_passed` now writes native `.passed` markers and no longer shells out to Python. ✅
- Native pass-cache invalidation is covered for changed file contents: content-addressed review IDs change when reviewed file content changes, so previously passed markers do not suppress new tasks. ✅
- `deepwork_get_review_instructions` now uses first-pass native rendering for `.deepreview` rules, DeepSchema-generated rules, explicit file filters, git changed-file detection, task output formatting, prompt file writing, prompt cleanup, precomputed context success/failure rendering, reference-file caps/truncation/unreadable markers, pass-marker suppression, invalid-config reporting, no-rule/no-match states, and Pi-native tool names. ✅
- `deepwork_get_configured_reviews` now uses first-pass native listing/filtering for `.deepreview` rules, DeepSchema-generated rules, exact subdirectory include/exclude filters, catch-all exclusion in filtered mode, and parse errors. ✅
- `/review` now reaches the native review instruction path via `getReviewInstructions`, supports file filters from command arguments, summarizes matched tasks/reviewers before dispatch, includes `review_id` and files-to-review metadata in parsed tasks, subagent prompts, and sequential fallback prompts, uses improved sequential fallback wording, and has requirement-traceable mocked extension tests for no-task, sequential, and subagent-spawn aggregation behavior. ✅
- `deepwork_get_configured_reviews` now returns richer native metadata for each rule: strategy, include/exclude patterns, selected reviewer, and additional-context flags, while preserving the existing `name`, `description`, and `defining_file` fields. ✅
- Remaining `/review` UX work: track completed subagent results when Pi exposes completion events, convert first-pass completion-loop guidance into automatic safe-fix/re-review orchestration when testable, and provide deeper user-visible review-rule summaries from the enriched configured-review metadata.
- Python fallback remains for review tools if native generation throws, unless `DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK=1` is set.
- DeepSchema-generated review rules are included in native review generation/configured listing and now participate in first-pass native workflow quality gates for `file_path` outputs. ✅
- Remaining: Native review rendering still needs deeper parity for exact Python pass-cache semantics, instruction ID formatting deltas, additional edge cases, configured-review output comparison against Python for uncommon rule fields, and real Pi dispatch behavior.
- Remaining: The current `.deepreview` schema warning in `deep-work` is either handled or reported clearly.

#### Phase 6: Port DeepSchema Discovery and Write Feedback — started

Implement native DeepSchema discovery and validation:

- Discover named schemas from project-local, standard, and environment-configured sources. ✅ first pass for review-rule generation and `deepwork_get_named_schemas`
- Parse schema manifests. ✅ first pass in `src/deepschema/discovery.ts`
- Match schemas to changed files. ✅ first pass through native review matching
- Generate write/edit feedback for Pi tool-result hooks. ✅ first pass in `src/deepschema/write-hook.ts`
- Execute `verification_bash_command` during write/edit feedback. ✅ first pass with timeout/error handling
- Generate synthetic review rules from schemas. ✅ first pass in `src/deepschema/reviews.ts`

Suggested files:

- `deepwork/src/deepschema/discovery.ts`
- `deepwork/src/deepschema/parser.ts`
- `deepwork/src/deepschema/validation.ts`
- `deepwork/src/deepschema/reviews.ts`

Success criteria:

- `deepwork_get_named_schemas` no longer calls Python. ✅
- Write/edit hooks no longer shell out to `uvx deepwork hook deepschema_write` on the normal native path. ✅ Python fallback remains if native feedback throws, unless `DEEPWORK_PI_DISABLE_DEEPSCHEMA_PYTHON_FALLBACK=1` is set.
- DeepSchema-generated review rules appear in review instruction generation and configured-review listing. ✅ first pass
- Native named-schema listing has requirement-traceable tests for project-local schemas, source precedence across project/standard/additional folders, and malformed-schema placeholders. ✅
- Native write/edit feedback has requirement-traceable tests for named schema guidance, anonymous schema guidance, JSON Schema validation failures, applicable anonymous schema parse errors, verification command failures/timeouts, and no-schema no-op behavior. ✅
- Pi extension event-handler tests cover write/edit DeepSchema feedback augmentation and git-commit review reminders. ✅
- Commit review reminders now use native git inspection of the last successful commit, filter rules to exact committed files, exclude pure catch-all rules, and respect native `.passed` markers when practical. ✅
- DeepSchema inheritance, references, examples, and missing-reference diagnostics have first-pass native review coverage. ✅
- Remaining follow-up: native write/edit feedback does not report invalid named schemas that might have matched if parse had succeeded, verification command behavior needs real-project parity validation, and DeepSchema-generated quality gates need deeper parity beyond the first-pass workflow `file_path` output integration.

#### Phase 7: Remove the Bridge

After native implementations exist, remove or drastically shrink `src/bridge.ts`.

Success criteria:

- No runtime path shells out to `uvx deepwork` for normal operation.
- No runtime path executes Python for normal operation.
- No runtime import references `deepwork.jobs.mcp` or `deepwork.review.mcp`.
- Docs no longer describe the Python bridge as an active runtime dependency.
- Package install works with Node/Pi dependencies only.

## Other Important Work

### Improve `/deepwork` UX

The `/deepwork` command now has a first-pass native workflow launcher UX.

Completed behavior:

- Parse `/deepwork status`. ✅
- List available workflows with `/deepwork`. ✅
- Surface job issue warnings from workflow discovery. ✅
- Parse and start `/deepwork <job>/<workflow>`. ✅
- Start a job name directly when the job has exactly one workflow. ✅
- Start a unique workflow-name or fuzzy summary match when unambiguous. ✅
- Ask concise clarification questions when ambiguous or missing. ✅
- Avoid MCP-oriented wording in user-facing command output. ✅
- Route `/deepwork learn` to `deepwork_jobs/new_job` when available. ✅
- Provide native draft `.deepwork/jobs` guidance when job-authoring workflow is unavailable or fails. ✅
- Requirement-traceable mocked extension tests cover status, list/issues, explicit start, unambiguous auto-start, ambiguous selection, missing-selection guidance, and first-pass learn routing/fallback behavior. ✅

Remaining needed behavior:

- Parse richer natural-language workflow requests with better intent matching.
- Preserve richer recorded conversation context for `/deepwork learn` beyond prompt guidance and optional command arguments.
- Offer deeper repair guidance when job issues are detected, once a native repair workflow exists.
- Add real Pi-session validation for command execution through the actual Pi command interface.

### Improve `/review` UX

The `/review` command generates native review tasks, supports file filters from command arguments, shows a concise matched-task/reviewer summary before dispatch, includes review IDs and files-to-review when native task metadata is available, dispatches Pi subagents when available, aggregates spawn failures into a sequential fallback, and avoids MCP-oriented wording. Requirement-traceable mocked extension tests cover these paths.

Remaining needed behavior:

- Track spawned review subagents through completion events when Pi exposes them and summarize their results.
- Show richer matched-rule metadata before dispatch when native review generation returns structured rule details, not just parsed task text.
- Apply obviously safe fixes automatically when the parent agent is in control.
- Ask before risky or subjective changes.
- Re-run reviews after fixes until clean or stopped.

### Improve `/configure-reviews` UX

The `/configure-reviews` command now has first-pass native Pi support. It registers as a Pi command, loads/summarizes the `configure-reviews` skill guidance, scans existing `.deepreview` files, lists configured reviews through native configured-review generation, optionally previews review instruction generation for file filters, and avoids MCP-oriented command wording. Requirement-traceable mocked extension tests cover the first-pass command behavior.

Remaining needed behavior:

- Convert guidance into a more interactive setup assistant when Pi command APIs support richer prompting.
- Offer concrete starter `.deepreview` templates based on detected languages/frameworks.
- Provide richer validation summaries that distinguish configured rules, matching rules, generated tasks, and parse errors.
- Add real Pi-session validation for the hyphenated command name and command output rendering.

### Improve `/record` and Recording Workflow Integration

The `/record` command now has first-pass native Pi support. It registers as a Pi command, loads/summarizes the `record` skill guidance, prompts for a workflow name when one is not provided, starts a prompt-based user-guided recording flow, avoids MCP-oriented wording, and points the user to `/deepwork learn`. It now persists a lightweight native recording note under `.deepwork/tmp/recordings/<session_id>.json` with the requested workflow name, timestamp, invocation context, and recent session context gathered from Pi's read-only session APIs (`buildSessionContext`, falling back to branch/entry messages when available). `/deepwork learn` loads that note, combines it with explicit `/deepwork learn ...` arguments, and passes the richer `recorded_context` into `deepwork_jobs/new_job` when available; otherwise the same context is included in draft `.deepwork/jobs` guidance. Requirement-traceable mocked extension tests cover these paths.

Current limitation:

- Pi command context exposes read-only session history, not an extension-owned live transcript recorder. The lightweight note captures recent context at `/record` invocation time and explicit `/deepwork learn` arguments, but it does not automatically append every later message/tool event in the recording flow unless Pi exposes additional session-event APIs or the user re-runs `/record`/provides context to `/deepwork learn`.

Remaining needed behavior:

- Validate the lightweight recording note behavior in a real Pi session.
- If Pi exposes reliable append/session event APIs for command extensions, append recording milestones after `/record` instead of only snapshotting recent context at command time.
- Provide direct draft job file creation assistance after user confirmation when the job-authoring workflow is unavailable.
- Add real Pi-session validation for `/record` and `/deepwork learn` command behavior.

### Tests

A first Vitest suite now exists and should be maintained requirement-by-requirement. Every test case that exists to satisfy or protect a requirement should include a nearby `PI-REQ-*` comment, enforced by `test/requirement-comment-lint.test.ts`.

Current test files:

- `test/get-workflows.golden.test.ts` — golden tests for native `getWorkflows` output.
- `test/workflow-discovery.test.ts` — unit tests for discovery ordering, parser behavior, issue reporting, and invocation text.
- `test/workflow-runtime-bridge.golden.test.ts` — compatibility goldens for workflow runtime behavior (`deepwork_start_workflow`, `deepwork_finished_step`, `deepwork_abort_workflow`, `deepwork_go_to_step`, and representative structured errors). These now pass against the first native TypeScript runtime implementation.
- `test/workflow-runtime-edge.test.ts` — native runtime edge tests for fallback session IDs, persisted stacks, native context restoration, optional/file outputs, missing required outputs, type mismatches, no-step workflow rejection, single-workflow auto-selection, nested stack abort/resume behavior, and quality-gate pass/fail/override/schema feedback.
- `test/quality-gate-parity.test.ts` — native quality-gate parity coverage for output-ref plus argument-level review ordering/naming, file_path review instruction content, process-requirement tasks, pass-marker suppression, and built-in inline-output content-change invalidation.
- `test/quality-gate-policy-rules.test.ts` — first-pass native quality-gate coverage for matching `.deepreview` rules, DeepSchema-generated synthetic review rules, unchanged-matching-file context, all-changed-filenames context, precomputed context, deterministic policy review ID compatibility with native review instruction generation, pass-marker suppression, and `needs_work` vs `next_step`/`workflow_complete` behavior for workflow output files.
- `test/workflow-e2e-quality-native.test.ts` — real-ish native end-to-end workflow coverage for repeated `finishedStep` calls with pass markers, early-step quality gates in multi-step workflows, status/context restoration after quality-gated advancement, and multi-file grouped quality gates for `individual`, `matches_together`, and `all_changed_files` strategies.
- `test/review-config-matching.test.ts` — first-pass native `.deepreview` discovery, parsing, validation-error reporting, explicit file matching, strategy grouping, include/exclude glob behavior, and git changed-file detection.
- `test/review-tools-native.test.ts` — native review instruction generation/configured-listing coverage for explicit files, git changed-file detection, task output shape, prompt file content, pass-marker suppression, content-change pass-cache invalidation, inline-content rendering, no-rules output, invalid `.deepreview` output, source locations, catch-all filtering, precomputed context success/failure, reference-file caps/truncation/unreadable markers, instruction-file cleanup, all_changed_files/unchanged_matching_files edge cases, exact configured-review filtering, and DeepSchema-generated review rules.
- `test/deepschema-tools-native.test.ts` — native `deepwork_get_named_schemas` coverage for project-local schemas, source precedence across project/standard/additional folders, and malformed-schema placeholders.
- `test/deepschema-write-hook-native.test.ts` — native DeepSchema write/edit feedback coverage for named/anonymous schema matching, requirements/instructions/reference/example guidance, JSON Schema validation feedback, verification command failure/timeout feedback, applicable parse-error feedback, and no-schema no-op behavior.
- `test/extension-event-handlers.test.ts` — Pi extension event-handler coverage for write/edit DeepSchema feedback augmentation and git-commit review reminders.
- `test/extension-deepwork-command.test.ts` — mocked Pi command coverage for `/deepwork status`, workflow listing with issue warnings, explicit workflow starts, unambiguous auto-starts, ambiguous selection prompts, and missing-selection guidance.
- `test/extension-configure-reviews-command.test.ts` — mocked Pi command coverage for `/configure-reviews` registration, configure-reviews skill guidance, `.deepreview` discovery, configured-review inspection, file-filtered validation previews, first-time setup guidance, and inspection-error reporting.
- `test/extension-record-command.test.ts` — mocked Pi command coverage for `/record` registration/guidance, workflow-name prompting, lightweight `.deepwork/tmp/recordings/<session_id>.json` state persistence, `/deepwork learn` routing to `deepwork_jobs/new_job` with saved recorded context, and draft `.deepwork/jobs` fallback guidance.
- `test/package-requirements.test.ts` — package, extension registration, skill, docs, native-boundary, and RFC 2119 checks.
- `test/requirement-comment-lint.test.ts` — ensures test cases have nearby requirement references.

Remaining recommended test layers:

1. Manual or automated Pi-session integration tests that run a real project workflow end-to-end through the actual Pi tool interface.
2. Additional nested sub-workflow tests if native sub-workflow delegation is expanded beyond explicit stack push/pop.
3. Additional review tests for exact Python parity deltas, complex pass-cache invalidation semantics beyond native content-addressed `.passed` marker compatibility, built-in quality-gate ID formatting if exact Python compatibility is required, and automatic `/review` command completion/fix-loop orchestration.
4. DeepSchema tests for invalid named schema feedback, inheritance error cases beyond review generation, environment-configured anonymous schema behavior, verification-command real parity, and deeper DeepSchema-generated quality-gate parity.
5. Additional extension event-handler tests for graceful failure paths beyond the current commit-success/failure and exact committed-file reminder filtering coverage.
6. Real Pi install smoke tests after each major port.

Test commands:

- `npm run check:package`
- `npm run typecheck`
- `npm test`
- `npm run test:update-golden` when intentionally updating `getWorkflows` goldens.
- `UPDATE_RUNTIME_GOLDEN=1 npm test -- test/workflow-runtime-bridge.golden.test.ts` when intentionally updating workflow-runtime bridge goldens.

### Package and Install Validation

Run package validation in a real Pi session:

1. `pi install ./deepwork -l` ✅ completed from `/Users/noah/Documents/GitHub/pi`; `pi list` shows project package `../deepwork`.
2. Confirm no package-local `.mcp.json` setup is required. ✅ `test ! -e deepwork/.mcp.json` passed.
3. Confirm skills are present on disk. ✅ `find deepwork/skills -maxdepth 2 -name SKILL.md` lists `configure-reviews`, `deepplan`, `deepreviews`, `deepschema`, `deepwork`, `new-user`, `record`, and `review`.
4. `/reload` in a real interactive Pi session. Not completed: non-interactive `pi -p '/reload' --no-session --model google/gemini-2.5-flash-lite` failed before command validation because no Google API key is configured in the shell environment.
5. Confirm skills are discovered by the real Pi UI/session. Not completed for the same no-provider-credential reason; package metadata and mocked registration tests pass.
6. Confirm native tools are visible in a real Pi session. Not completed for the same no-provider-credential reason; mocked extension registration tests cover the expected native `deepwork_*` tool names.
7. Call `deepwork_get_workflows` through the real Pi tool UI. Not completed; native implementation and tests pass, but real Pi tool invocation still needs an authenticated interactive session.
8. Run `/deepwork` in a real session. Partial: non-interactive `pi -p '/deepwork'` exited 0 but produced no useful transcript/output, so this does not count as full validation.
9. Run `/record` and `/deepwork learn` in a real session. Partial: non-interactive `pi -p '/record test_flow'` and `pi -p '/deepwork learn test_flow'` exited 0 but produced no useful transcript/output and did not create a recording note, so this does not count as full validation.
10. Run `/review` in a project with matching review rules. Not completed: non-interactive `pi -p '/review' --no-session --model google/gemini-2.5-flash-lite` failed before command validation because no Google API key is configured in the shell environment.
11. Validate DeepSchema write/edit feedback through actual Pi write/edit tool-result augmentation. Not completed; mocked event-handler and native write-hook tests pass, but real Pi tool-result behavior still needs an authenticated interactive session.

Latest validation attempt result: package installation/discovery via `pi list`, package-local no-`.mcp.json`, skills-on-disk, and all npm validations are clean. Full real Pi command/tool validation remains blocked in this shell by missing provider credentials, and should be retried in an authenticated interactive Pi session rather than inferred from non-interactive slash-command exit codes.

### Documentation Cleanup

Once native TypeScript implementations replace the bridge:

- Update `README.md` to remove bridge caveats.
- Update `docs/native-bridge.md` or replace it with architecture docs.
- Add migration notes from the existing DeepWork Pi plugin.
- Add troubleshooting docs for missing workflows, invalid `.deepreview`, and missing schemas.

## Suggested Work Order

1. Maintain requirement-traceable tests for every newly implemented behavior. ✅ initial suite added.
2. Port workflow discovery and parsing to TypeScript. ✅ first pass complete.
3. Add compatibility golden fixtures for workflow runtime operations before replacing them. ✅ first pass complete for start, finish/next, finish/complete, abort, go-to-step, and representative structured errors.
4. Port workflow state management and step advancement. ✅ first pass complete for basic single-workflow runtime with quality-gate override.
5. Expand workflow runtime coverage for optional/file outputs, no-step workflows, single-workflow auto-selection, nested stacks, and status/context restoration. ✅
6. Port native quality-gate review evaluation for workflow outputs and JSON schemas. ✅ first pass complete.
7. Add quality-gate parity coverage for process requirements, file-output instruction rendering, output-ref plus argument review ordering, and pass-cache behavior. ✅
8. Port review config parsing and changed-file matching. ✅ first pass complete.
9. Add review tool coverage before replacing bridge paths. ✅ first native/parity-style coverage added for explicit files, changed-file detection, no rules, invalid configs, task shape, prompt content, pass markers, and configured-review filtering.
10. Port review instruction rendering with Pi-native formatting and wire it into `deepwork_get_review_instructions`. ✅ first pass complete.
11. Port configured-review listing and pass-cache behavior fully enough to replace `deepwork_get_configured_reviews`. ✅ first pass complete for `.deepreview` rules and parse errors.
12. Expand native review parity for precomputed context, reference-file caps, unreadable/truncated reference files, instruction-file cleanup, and DeepSchema-generated rules. ✅ first pass complete.
13. Expand native review parity for exact Python behavior deltas, complex pass-cache invalidation semantics, deterministic ID compatibility, and automatic `/review` completion/fix-loop behavior. ✅ first-pass native content-change invalidation and command guidance added; deeper automation/parity remains.
14. Run end-to-end Pi validation for the native workflow runtime and first native review paths.
15. Port remaining DeepSchema validation, generated quality gates, and write feedback. ✅ named-schema listing and first-pass write/edit feedback complete.
16. Add extension event-handler tests for native DeepSchema write/edit feedback and commit review reminders. ✅
17. Port native DeepSchema `verification_bash_command` execution for write/edit feedback. ✅ first pass complete
18. Port DeepSchema-generated quality gates and/or `.deepreview` quality-gate integration. ✅ first pass complete for workflow `file_path` outputs.
19. Improve commit review reminders to filter exact committed files, exclude pure catch-all rules, and respect passed reviews. ✅ first pass complete
20. Deepen quality-gate parity for unchanged matching files, all changed filenames, precomputed context, deterministic IDs, and real-project behavior. ✅ first pass complete for policy quality gates.
21. Add real-ish end-to-end workflow tests for repeated quality-gate pass-marker flows, multi-step workflows, and complex policy contexts. ✅
22. Document whether built-in workflow-output and process-requirement quality review IDs must exactly match Python IDs. ✅ currently documented as a parity gap rather than a required compatibility contract.
23. Run real Pi-session validation for native workflow runtime, quality gates, review generation, DeepSchema write feedback, and commit reminders. Partial attempt completed on 2026-05-15; package discovery and npm validations passed, but interactive command/tool validation is still blocked by missing provider credentials in the shell environment.
24. Improve `/review` command argument filtering, summary, fallback wording, spawn aggregation, and completion-loop guidance tests now that native review generation is in place. ✅ first pass complete.
25. Improve `/deepwork` command status/list/start/ambiguity UX and add mocked command tests. ✅ first pass complete.
26. Improve `/configure-reviews` command guidance/inspection/validation UX and add mocked command tests. ✅ first pass complete.
27. Improve `/record` UX and command/workflow integration. ✅ first pass complete with direct `/record`, record-skill guidance, lightweight `.deepwork/tmp/recordings` state, and `/deepwork learn` job-authoring routing/fallback guidance using saved recorded context.
28. Deepen `/deepwork` natural-language matching and validate `/deepwork learn` recorded-context integration in a real Pi session.
29. Remove remaining Python bridge runtime paths/fallbacks once parity is strong enough.
30. Run full Pi install/session validation in an authenticated interactive Pi session.

## Known Caveats From the First Pass

- `src/bridge.ts` still uses Python/`uvx` as fallback for review instruction generation/configured-review listing and as fallback for DeepSchema write hooks if the native write-hook path throws. Active workflow stack restoration, `deepwork_mark_review_as_passed`, `deepwork_get_named_schemas`, first-pass DeepSchema write feedback, first-pass workflow quality gates, first-pass `.deepreview` review generation/listing, first-pass DeepSchema-generated review rules, and first-pass `.deepreview`/DeepSchema workflow quality-gate rules for `file_path` outputs are now native.
- Review generation no longer normally falls back to the Codex renderer for `.deepreview` rules, but Python fallback can still do so if native review generation throws and fallback is not disabled.
- `/deepwork` is now a first-pass workflow launcher for status, listing, explicit starts, unambiguous starts, ambiguity guidance, and `/deepwork learn` routing to `deepwork_jobs/new_job` with lightweight saved recording context when available, but it still needs richer natural-language matching and real Pi-session validation.
- `/review` now gives first-pass safe-fix/user-confirmation/re-run guidance, but it does not yet implement a full automatic fix/re-review loop.
- `/configure-reviews` is now a first-pass guidance/inspection/validation command, but it does not yet provide interactive templates, direct file editing assistance, or real Pi-session validation for hyphenated command behavior.
- `/record` is now a first-pass direct command that loads record skill guidance and persists a lightweight recording note under `.deepwork/tmp/recordings/<session_id>.json`; `/deepwork learn` consumes that note when routing to `deepwork_jobs/new_job`. Capture is still a point-in-time snapshot plus explicit user-provided context rather than a continuous transcript recorder, and needs real Pi-session validation.
- Commit review reminders now inspect `HEAD` after successful commit commands and filter exact committed files against non-catch-all rules, but they still need real Pi session validation and deeper parity for complex pass-cache invalidation cases beyond native content-addressed review IDs.
- DeepSchema write feedback no longer shells out on the normal path and now executes schema `verification_bash_command` natively with timeout/error handling, but command behavior still needs real-project parity validation and Python fallback remains if native write feedback throws unless `DEEPWORK_PI_DISABLE_DEEPSCHEMA_PYTHON_FALLBACK=1` is set.
- A Vitest suite exists for native workflow discovery/parsing, package metadata, extension registration, skills/docs, native-boundary checks, workflow-runtime compatibility goldens, workflow-runtime edge cases, extension command/event handlers, and requirement-comment linting.
- Native workflow state, output validation, nested stack push/pop, and active-stack context restoration have a first implementation, but still need real Pi install/session validation.
- Native quality gates now cover no-review pass, workflow-output review task generation, JSON-schema failure, override behavior, output-ref plus argument-level review ordering, file_path review instructions, process-requirement tasks, `.deepreview` matching integration, DeepSchema-generated rules, unchanged-matching-file context, all-changed-filenames context, precomputed context, deterministic policy review IDs shared with native review generation, pass-marker suppression, real-ish multi-step advancement after pass markers, status/context restoration, and multi-file grouped policy strategies, but still need real Pi install/session validation and deeper parity for built-in quality task IDs plus complex pass-cache invalidation.
- Native `.deepreview` parsing, validation, matching, strategy grouping, git changed-file detection, instruction rendering, configured-review listing, pass-marker suppression, precomputed context rendering, reference-file cap handling, prompt cleanup, and DeepSchema-generated review rules have first implementations. `/review` command argument filters, matched-task summaries, sequential fallback wording, and spawn-failure aggregation now have first-pass implementation and tests, but exact pass-cache parity, deterministic ID compatibility, review completion/fix-loop behavior, and real Pi install/session behavior still need deeper implementation and tests.
