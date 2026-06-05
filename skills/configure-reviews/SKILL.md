---
name: configure-reviews
description: "Set up DeepWork Reviews using .deepreview config files"
---

# Configure DeepWork Reviews

Help the user create or improve automated review rules for a project. This native Pi package uses Pi commands and tools directly; it does not use MCP.

## Required Reference

Before creating or modifying `.deepreview` files, read `deepwork/docs/README_REVIEWS.md` from this package. Use it as the reference for config shape, strategies, changed-file detection, generated DeepSchema reviews, quality gates, and pass caching.

## Flow

1. Read the review reference documentation if you have not already read it in this conversation.
2. Inspect existing `.deepreview` files in the project.
3. Reuse existing rules, shared instruction files, and `.deepwork/review/` prompts when practical.
4. Ask clarifying questions only when the desired policy is unclear.
5. Create or update `.deepreview` YAML files close to the files they govern.
6. Prefer small, practical, actionable review instructions.
7. Minimize reviewer count. Combine rules when the instructions are short and the file set is identical.
8. Test the change by creating or identifying a triggering file change, then call `deepwork_get_review_instructions` with `autostart_reviews_if_possible: false` and verify the expected rule appears without launching reviewers.
9. Revert any artificial trigger change used only for testing.
10. Summarize the created or changed rules.
11. Ask whether the user wants to run `/review` after a material set of changes is complete or when confirming a PR is in good form. Explain that running reviews can be expensive.

## Placement Guidance

- Root `.deepreview` files are appropriate for project-wide policies.
- Nested `.deepreview` files are appropriate for policies owned by a directory or team.
- Globs are relative to the directory containing the `.deepreview` file.
- Put reusable long instructions in `.deepwork/review/` and reference them with `instructions.file`.

## Native Review Tools

Use these tools to validate configuration:

- `deepwork_get_configured_reviews` — inspect configured rules and rule applicability.
- `deepwork_get_review_instructions` — generate the review tasks that `/review` would run. Set `autostart_reviews_if_possible: false` when validating rule discovery or previewing tasks without running reviewers.
- `deepwork_mark_review_as_passed` — mark a completed passing review by review ID.

Do not invent rule behavior. If the user asks for unsupported behavior, explain the nearest supported rule structure and ask whether that meets the need.
