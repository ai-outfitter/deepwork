---
name: deepreviews
description: "Reference documentation for DeepWork Reviews"
---

# DeepWork Reviews Reference

Use this skill when you need reference material for `.deepreview` rules, review strategies, DeepSchema-generated reviews, workflow quality gates, or review pass caching.

## Primary Reference

Read `deepwork/docs/README_REVIEWS.md` before answering detailed questions or editing review configuration.

## Summary

DeepWork Reviews define automated review policies using `.deepreview` files placed anywhere in a project. A review detects changed files, matches them against rules, and generates focused review tasks for Pi agents or Pi subagents.

Reviews run:

- On demand through `/review` or `deepwork_get_review_instructions`.
- During workflow quality gates when `deepwork_finished_step` validates step outputs.
- As normal `change_cycle` reviews by default; PR-only rules use `lifecycle.cadence: pull_request` and are run with PR review mode, e.g. `/review --pr` or `deepwork_get_review_instructions` with `review_cadence: "pull_request"`.

Running reviews can be expensive because review tasks may launch focused reviewer agents. Prefer running them after a material set of changes is complete, when explicitly requested, or when confirming a PR is in good form. For configuration or schema validation where you only need to confirm which tasks would be generated, call `deepwork_get_review_instructions` with `autostart_reviews_if_possible: false`.

## Native Pi Tools

- `deepwork_get_review_instructions` — generate review tasks. `autostart_reviews_if_possible` defaults to `true`; set it to `false` to preview or validate tasks without launching reviewers.
- `deepwork_get_configured_reviews` — list configured rules for the current scope.
- `deepwork_mark_review_as_passed` — cache a passing review result for unchanged files.

This native Pi package uses Pi tools directly; it does not use MCP.

## Basic `.deepreview` Example

```yaml
python_quality:
  description: "Review Python files for maintainability and correctness."
  match:
    include:
      - "**/*.py"
    exclude:
      - "**/generated/**"
  review:
    strategy: individual
    instructions: |
      Review this file for correctness, clear error handling, and maintainability.
```

## PR Cadence and Cache Invalidation

Use `lifecycle.cadence: pull_request` for broad final reviews that should stay separate from normal change-cycle reviews.

```yaml
pr_summary:
  description: "Review the PR as a whole based on the changed file set."
  lifecycle:
    cadence: pull_request
  match:
    include:
      - "**/*"
  review:
    strategy: all_changed_files
    cache:
      invalidates_on: changed_file_set
    additional_context:
      all_changed_filenames: true
    instructions: |
      Provide a PR-level summary and risk review. Do not perform a line-level implementation review.
```

`review.cache.invalidates_on` defaults to `file_content`. Use `changed_file_set` when a passed review should remain valid while file contents churn, and should rerun only when the reviewed changed-file set changes.

## Cache Invalidation Keys

Configure pass-cache behavior under `review.cache.invalidates_on`:

- `file_content` — default. Re-run when reviewed file contents or inline review content change.
- `changed_file_set` — re-run when the reviewed changed-file set changes. Inline review content still invalidates the cache when present.

## Strategies

- `individual` — one review task per matched file.
- `matches_together` — one review task for all matched files.
- `all_changed_files` — if any file matches, review every changed file.

## DeepSchema Reviews

DeepSchemas can generate review rules from their semantic requirements. These generated rules participate in `/review` and workflow quality gates alongside `.deepreview` rules.

## Quality Gates

When a workflow step declares review criteria, `deepwork_finished_step` can return `needs_work` with review feedback. Fix the output and submit the step again unless the user explicitly authorizes an override.
