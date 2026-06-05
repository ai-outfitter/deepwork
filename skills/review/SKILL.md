---
name: review
description: "Run DeepWork Reviews on the current branch using .deepreview rules"
---

# DeepWork Review

Run focused code reviews from `.deepreview` rules and DeepSchema-generated review rules. This native Pi package uses Pi commands and tools directly; it does not use MCP.

## Routing

Stop and redirect when either condition applies:

- The user wants to configure, create, or modify review rules: use the `configure-reviews` skill or `/configure-reviews` command when available.
- The user wants to create or update DeepSchemas: use the `deepschema` skill.

Proceed only when the user wants to run reviews.

Running reviews can be expensive because it may generate and launch multiple focused reviewer agents. Run reviews only after a material set of changes has been completed, when the user explicitly asks for review, or when confirming a PR is in good form.

## Preferred Command

Use `/review` when the command is available. The command generates native Pi review tasks, dispatches Pi subagents when available, and provides a sequential fallback when subagents are unavailable.

## Manual Native Tool Flow

If this skill is loaded instead of the `/review` command:

1. Call `deepwork_get_review_instructions`.
   - No `files` argument reviews the current branch's detected changes.
   - A `files` list reviews only those files.
   - `autostart_reviews_if_possible` defaults to `true`; set it to `false` only when you need to inspect/validate generated review tasks without launching reviewers.
2. If no rules are configured, ask whether the user wants to set up rules. If yes, use `configure-reviews`.
3. For each returned task, read the `prompt_file`, follow it exactly, and inspect the listed files from the stated project root.
4. Dispatch independent tasks to Pi subagents when available. Otherwise, run them one at a time in this session.
5. Report findings with file paths and line references where possible.
6. Apply obviously correct, low-risk fixes immediately.
7. Ask the user before applying refactors, architectural changes, subjective style changes, or other risky fixes.
8. Re-run applicable reviews after edits until no actionable findings remain or the user explicitly stops.

## Changelog and PR Description Check

When relevant, run this alongside review tasks:

1. Check for a changelog file.
2. If a changelog exists and branch commits or changed files affect user-visible behavior, verify the unreleased/current section reflects the branch.
3. If a PR is open and the changelog changed, verify the PR description matches.

## Acting on Review Results

- Fix concrete correctness, typo, formatting, and unused-code findings when the fix is obvious.
- Ask before broad rewrites, public API changes, behavior changes, or debatable style changes.
- When a review passes, call `deepwork_mark_review_as_passed` with the review ID from the task or prompt file.
- Do not mark a review as passed while actionable findings remain.

## Iteration

After making a material set of fixes, call `deepwork_get_review_instructions` with `files` set to the files edited during the iteration when that is enough to re-check the relevant findings. If broader changes could affect other rules, run the review without a file filter. Avoid re-running after every tiny edit unless a review finding specifically requires immediate confirmation.
