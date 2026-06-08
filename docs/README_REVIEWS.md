# DeepWork Reviews for Pi

DeepWork Reviews define automated review policies with `.deepreview` files. The native Pi package generates focused review tasks for Pi agents and Pi subagents through `/review` and native `deepwork_*` tools. It does not use MCP.

## What Reviews Do

1. Detect changed files in the current project.
2. Discover `.deepreview` files from the project tree.
3. Match changed files against named rules.
4. Generate self-contained review instruction files in `.deepwork/tmp/review_instructions/`.
5. Dispatch review tasks through `pi-subagents` when that extension is available, or present review tasks for sequential in-session review otherwise.
6. Cache passing reviews so unchanged files are not re-reviewed unnecessarily.

## Changed-File Detection

When review tools run without an explicit file list, DeepWork uses local git state.

Included:

- committed changes on the current branch since the merge base with the base branch
- staged changes
- unstaged modifications to tracked files
- untracked, non-ignored files

Excluded:

- deleted files, because there is no file content to inspect
- ignored files

Detection is local. DeepWork does not need a remote network call to decide which files changed. If local branch metadata is stale, run normal git commands such as `git fetch` before review.

To review a specific scope, pass explicit files to `deepwork_get_review_instructions` or use the `/review` command's file-specific behavior when available.

## `.deepreview` Placement

A `.deepreview` file is YAML. It can live at the repository root or in a subdirectory. Match globs are relative to the directory containing the `.deepreview` file.

```text
project/
  .deepreview
  src/
    .deepreview
  docs/
    .deepreview
```

Rules from separate files are independent. Place rules close to the files they govern when ownership or scope is local.

## Rule Shape

```yaml
rule_name:
  description: "Short human-readable description."
  lifecycle:
    cadence: change_cycle
  match:
    include:
      - "src/**/*.ts"
    exclude:
      - "src/generated/**"
  review:
    strategy: individual
    instructions: |
      Review this file for correctness, maintainability, and edge cases.
    cache:
      invalidates_on: file_content
    precomputed_info_for_reviewer_bash_command: scripts/review-context.sh
    reference_files:
      - path: "docs/style-guide.md"
        description: "Project style guide"
    additional_context:
      all_changed_filenames: true
      unchanged_matching_files: false
```

Fields:

- `description` — required summary of the rule.
- `lifecycle.cadence` — optional review cadence. Defaults to `change_cycle`; use `pull_request` for PR-only reviews.
- `match.include` — required list of glob patterns.
- `match.exclude` — optional list of glob patterns to skip.
- `review.strategy` — required grouping strategy.
- `review.instructions` — required inline text or file reference.
- `review.cache.invalidates_on` — optional pass-cache invalidation mode. Defaults to `file_content`; use `changed_file_set` for PR summary-style reviews that only need to rerun when the reviewed file set changes.
- `review.precomputed_info_for_reviewer_bash_command` — optional shell command whose stdout is added to the review prompt as precomputed context.
- `review.reference_files` — optional files to inline into review prompts.
- `review.additional_context` — optional flags for extra context.
- `review.review_depth` — optional depth hint. Set to `lightweight` on job.yml review blocks to omit the workflow's `common_job_info` preamble from the reviewer's prompt, reducing token usage when the reviewed artifact is self-contained (e.g. screenshot visual quality checks). Step inputs are always included. Has no effect in `.deepreview` rules (those rules have no associated workflow).

## Instruction Files

`review.instructions` can be inline text:

```yaml
review:
  instructions: |
    Check for input validation and safe error handling.
```

It can also reference another file:

```yaml
review:
  instructions:
    file: .deepwork/review/typescript-security.md
```

Use instruction files for longer shared policies. Paths are resolved relative to the `.deepreview` file that declares the rule.

## Review Cadence

Rules default to normal change-cycle reviews:

```yaml
lifecycle:
  cadence: change_cycle
```

Use pull-request cadence for broad reviews that should not run during every normal review cycle or workflow quality gate:

```yaml
lifecycle:
  cadence: pull_request
```

Run PR reviews with `/review --pr` or by calling `deepwork_get_review_instructions` with `review_cadence: "pull_request"`. Normal `/review` and quality-gate checks use `change_cycle` rules.

### Triggering PR Reviews

Use PR review mode when you want only `pull_request` cadence rules:

```text
/review --pr
```

You can also scope PR reviews to explicit files:

```text
/review --pr src/app.ts docs/guide.md
```

Or call the native tool directly:

```json
{
  "review_cadence": "pull_request"
}
```

```json
{
  "review_cadence": "pull_request",
  "files": ["src/app.ts", "docs/guide.md"]
}
```

## Review Strategies

### `individual`

Creates one task per matched changed file.

Best for:

- file-level style checks
- language-specific best practices
- local correctness reviews

### `matches_together`

Creates one task containing all matched changed files.

Best for:

- cross-file consistency
- migrations
- paired implementation and tests
- docs that describe a specific code area

### `all_changed_files`

Uses the match as a trigger. If any changed file matches, the task receives all changed files.

Best for:

- security tripwires
- broad risk reviews
- sensitive areas where small changes can affect unrelated files

## Pass Cache Invalidation

DeepWork pass markers are keyed by the generated review ID. Configure what makes that ID change with `review.cache.invalidates_on`:

- `file_content` — default. Re-run when reviewed file contents change.
- `changed_file_set` — re-run only when the set of reviewed changed files changes. This is useful for PR-level summaries, release-note prompts, or documentation completeness checks where final-period line churn should not invalidate the all-up review.

Example:

```yaml
review:
  strategy: all_changed_files
  cache:
    invalidates_on: changed_file_set
```

## Additional Context

`all_changed_filenames: true` adds a list of every changed filename to the task. Use it when reviewers should notice related files even if they do not inspect every file.

`unchanged_matching_files: true` adds matching files that were not changed. Use it for consistency checks such as version alignment, route tables, indexes, generated registries, or paired docs.

## Precomputed Reviewer Context

`precomputed_info_for_reviewer_bash_command` runs a shell command before instruction files are written and injects the command's stdout into a `## Precomputed Context` prompt section.

```yaml
review:
  strategy: matches_together
  precomputed_info_for_reviewer_bash_command: scripts/summarize-api.sh
  instructions: |
    Review these changes using the precomputed API summary.
```

The command string is resolved relative to the `.deepreview` file's directory and executed from the project root. Use it when deterministic local tooling can cheaply prepare context for the reviewer, such as dependency graphs, generated API summaries, route listings, schema summaries, or test-selection output.

DeepWork gives precompute commands a 60 second timeout. Successful commands contribute stdout. Failed commands do not abort review generation; the prompt includes a failure marker with the exit code and stderr. Timed-out commands likewise produce a timeout marker. Avoid commands with side effects, network dependencies, secrets, or long-running interactive behavior.

## Reference Files

`reference_files` inline small support files into the review prompt. Use them for style guides, API contracts, schemas, examples, or domain rules.

DeepWork caps inlined content to keep prompts usable. Files beyond the count or byte limit are listed as omitted. Missing or unreadable files produce a marker rather than aborting the whole review.

## Agent Selection and Subagent Dispatch

A rule can request a reviewer persona. For native Pi, prefer Pi-compatible reviewer names when the extension supports dispatching subagents. If no persona is specified, the default Pi review agent is used.

```yaml
review:
  strategy: matches_together
  agent:
    pi: security-reviewer
  instructions: |
    Review these files for authentication and authorization regressions.
```

When `pi-subagents` is installed and its event bridge is active, `/review` and `deepwork_get_review_instructions` automatically launch matching review tasks as async fresh-context subagents by default. DeepWork sends each subagent a compact prompt that points at the generated `prompt_file`; the prompt file remains the authoritative review context. The generated request uses parallel subagent execution with a small concurrency cap, maps the default `deepwork-reviewer` persona to Pi's built-in `reviewer` agent, and asks subagents not to edit project/source files unless a review instruction explicitly permits it.

Set `autostart_reviews_if_possible: false` on `deepwork_get_review_instructions` when you only need to preview or validate generated tasks, such as checking new `.deepreview` rules or DeepSchema-generated reviews. Running reviews can be expensive, so prefer launching them after a material set of changes is complete, when explicitly requested, or when confirming a PR is in good form.

In autostart mode, `deepwork_get_review_instructions` intentionally returns reduced context: a request ID, the launched reviewer list, review IDs, rule names, files, and prompt paths. It does not duplicate the full review prompt content in the tool response. Completion and status are handled by `pi-subagents` async notifications/status. If autostart is disabled, `pi-subagents` is unavailable, or `pi-subagents` does not acknowledge the launch request, DeepWork preserves the normal fallback behavior and returns the review tasks for sequential in-session execution.

Every generated prompt tells reviewers to call `deepwork_mark_review_as_passed` with the review ID if, and only if, the review passes with no actionable findings. If that tool is unavailable inside a review subagent, the prompt gives the reviewer an exact `DEEPWORK_REVIEW_PASSED: <review_id>` fallback line to include only on a passing review; the parent DeepWork extension listens for that marker from launched review subagents and records the pass. Reviewers must not mark or report a review passed while findings remain.

## DeepSchema-Generated Reviews

DeepSchemas can generate review rules from schema requirements. Generated reviews participate in `/review` and workflow quality gates just like `.deepreview` rules.

Use DeepSchema requirements for semantic rules that need judgment:

```yaml
requirements:
  no-secrets: "Config files MUST NOT contain secrets or credentials."
```

Use JSON Schema or verification commands for structural and deterministic checks.

## Workflow Quality Gates

Workflow steps can declare review criteria for outputs. When `deepwork_finished_step` receives outputs, DeepWork may run quality-gate reviews. If a review fails, the response status is `needs_work` with feedback. Fix the output and submit again.

Only bypass a quality gate when the user explicitly accepts the risk and provides a clear reason.

## Pass Caching

When a review passes, call `deepwork_mark_review_as_passed` with the review ID. For `file_content` rules, DeepWork records the pass for the unchanged reviewed file content. For `changed_file_set` rules, DeepWork records the pass for the sorted reviewed file set, so content-only churn does not make the review eligible again.

Do not mark a review as passed when actionable findings remain.

## Native Pi Tools

- `deepwork_get_review_instructions` — generate review tasks for changed or specified files. `autostart_reviews_if_possible` defaults to `true`; set it to `false` to inspect generated tasks without launching reviewers.
- `deepwork_get_configured_reviews` — list configured matching review rules.
- `deepwork_mark_review_as_passed` — record that a review passed.

## Practical Rule Examples

### TypeScript Correctness

```yaml
typescript_correctness:
  description: "Review TypeScript source for correctness and maintainability."
  match:
    include:
      - "src/**/*.ts"
      - "src/**/*.tsx"
    exclude:
      - "src/generated/**"
  review:
    strategy: individual
    instructions: |
      Check for runtime errors, missing null handling, accidental API changes,
      and unnecessary complexity. Report only actionable findings.
```

### Docs and Code Sync

```yaml
docs_code_sync:
  description: "Verify docs stay in sync with the implementation."
  match:
    include:
      - "docs/**/*.md"
      - "src/public-api/**"
  review:
    strategy: matches_together
    additional_context:
      unchanged_matching_files: true
    instructions: |
      Review the changed docs and public API files together. Flag mismatches,
      stale examples, missing behavior notes, and inaccurate command names.
```

### Security Tripwire

```yaml
auth_security_tripwire:
  description: "Run a broader security review when authentication changes."
  match:
    include:
      - "src/auth/**"
      - "config/security*.yml"
  review:
    strategy: all_changed_files
    additional_context:
      all_changed_filenames: true
    instructions: |
      Authentication or security configuration changed. Review all changed files
      for authorization bypasses, leaked secrets, unsafe defaults, and missing tests.
```
