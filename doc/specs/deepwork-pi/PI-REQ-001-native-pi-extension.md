# PI-REQ-001: Native Pi Extension

## Overview

The DeepWork Pi extension is the primary distribution mechanism for DeepWork on Pi. It provides native Pi tools, commands, skills, and lifecycle integrations for running workflows, running code reviews, configuring review rules, applying DeepSchema validation, and restoring workflow context. The extension MUST NOT expose DeepWork to Pi through MCP. It SHOULD reuse the existing DeepWork Python implementation through a local command/JSON bridge or reusable library calls where that avoids duplicating workflow, review, schema, and state-management logic.

## Source Material

This requirement file was copied and adapted from `deep-work/doc/specs/deepwork/cli_plugins/PLUG-REQ-001-claude-code-plugin.md`.

## Requirements

### PI-REQ-001.1: Package Layout

1. The package MUST reside at `deepwork/`.
2. The package MUST provide a Pi package manifest in `deepwork/package.json`.
3. The package manifest `name` field MUST be `deepwork`.
4. The package manifest MUST include `description`, `version`, `license`, and `repository` fields.
5. The package manifest MUST declare Pi extension entry points using the `pi.extensions` field.
6. The package manifest MUST declare Pi skill directories using the `pi.skills` field.
7. Runtime dependencies required by the extension MUST be listed in `dependencies`, not only in `devDependencies`.

### PI-REQ-001.2: Native Pi Extension Entry Point

1. The package MUST provide an extension entry point at `deepwork/index.ts` or `deepwork/src/index.ts`.
2. The extension entry point MUST export a default Pi extension factory compatible with `@earendil-works/pi-coding-agent`'s `ExtensionAPI`.
3. The extension MUST register native Pi tools with `pi.registerTool()` for all DeepWork workflow, review, and schema operations listed in PI-REQ-002.
4. The extension MUST NOT require `.mcp.json` configuration for normal operation.
5. The extension MUST NOT register, start, proxy, or depend on a DeepWork MCP server for normal operation.
6. The extension MAY execute the existing `deepwork` CLI as an implementation detail when a native in-process API is unavailable, provided the Pi-facing interface remains native Pi tools and commands.
7. The extension SHOULD keep any CLI bridge small, typed, and centralized so that future implementation can replace it with direct library calls.

### PI-REQ-001.3: DeepWork Command

1. The extension MUST register a `/deepwork` command.
2. The `/deepwork` command MUST help users discover available workflows, start named workflows, continue active workflows, abort workflows, navigate to prior steps, and create new jobs.
3. The `/deepwork` command MUST use native Pi tools or shared native implementation modules rather than MCP tools.
4. The `/deepwork` command MUST prompt the user for clarification when the requested workflow or job is ambiguous.
5. The `/deepwork` command MUST route new-job creation to the existing DeepWork job-authoring workflow or its native Pi equivalent.

### PI-REQ-001.4: Review Command

1. The extension MUST register a `/review` command.
2. The extension MAY also register `/deepwork_review` as an alias for compatibility.
3. The review command MUST generate review tasks using native Pi implementation code rather than MCP review tools.
4. The review command MUST dispatch review tasks through Pi-native subagent facilities when available.
5. The review command MUST provide a sequential fallback prompt when Pi-native subagent facilities are unavailable.
6. The review command MUST automatically apply findings that are obviously correct and have no meaningful downside, such as typo fixes and unused import removal.
7. The review command MUST present subjective findings, architectural trade-offs, and risky changes to the user before applying them.
8. The review command MUST re-run applicable reviews after changes and MUST repeat until no actionable findings remain or the user explicitly stops.
9. The review command MUST redirect review-rule configuration requests to the configure-reviews skill or command.
10. When no review rules are configured, the review command MUST offer to help the user discover and set up review rules.

### PI-REQ-001.5: Configure Reviews Command and Skill

1. The extension MUST provide a `configure-reviews` skill at `deepwork/skills/configure-reviews/SKILL.md`.
2. The extension SHOULD register a `/configure-reviews` command if Pi command naming allows hyphenated command names.
3. The configure-reviews instructions MUST require the agent to consult the DeepWork Reviews reference documentation before creating or modifying `.deepreview` files.
4. The configure-reviews instructions MUST require the agent to reuse existing review rules and instructions where practical.
5. The configure-reviews instructions MUST require testing new or changed rules by running a native Pi review instruction generation path and verifying the expected rule appears.

### PI-REQ-001.6: Skills

1. The extension MUST provide Pi skills for `deepwork`, `review`, `configure-reviews`, `deepreviews`, `deepschema`, `deepplan`, `new-user`, and `record` unless a requirement is explicitly removed in a later requirements file.
2. Each skill MUST reside in its own directory under `deepwork/skills/`.
3. Each skill directory MUST contain a `SKILL.md` file.
4. The `name` field in each skill's YAML frontmatter MUST match its directory name.
5. Skill names MUST use only lowercase letters, decimal digits, and hyphens.
6. Each skill's YAML frontmatter MUST include a `description` field.
7. Skill instructions MUST describe native Pi tools and commands, not MCP tools.
8. Skill instructions SHOULD reuse wording from the existing DeepWork plugin skills when the behavior remains the same.

### PI-REQ-001.7: Reference Documentation

1. The package MUST include DeepWork Reviews reference documentation accessible to the `deepreviews` skill.
2. The reference documentation SHOULD be copied or symlinked from the canonical DeepWork documentation when packaging constraints allow it.
3. The reference documentation MUST explain `.deepreview` config format, review strategies, changed-file detection, DeepSchema-generated synthetic review rules, workflow quality gates, and pass caching.
4. The package MUST include user-facing setup documentation in `deepwork/README.md`.
5. The setup documentation MUST state that the package uses native Pi tools and does not require MCP configuration.

### PI-REQ-001.8: Session Context Restoration

1. The extension MUST restore active DeepWork workflow context on Pi session start or agent start.
2. Restored context MUST include session ID, workflow name, goal, current step, completed steps, common job info, and current step instructions when available.
3. The extension MUST inject restored context through Pi-native extension events or messages.
4. The extension MUST degrade gracefully when no active session exists.
5. The extension MUST NOT fail Pi startup when workflow state cannot be read.

### PI-REQ-001.9: Session and Agent Identity

1. The extension MUST maintain a Pi session identifier for DeepWork state operations.
2. The extension MUST maintain a Pi agent identifier for subagent or delegated work when Pi exposes one.
3. Native Pi tool calls that mutate or inspect workflow state MUST accept optional `session_id` and `agent_id` parameters when those parameters are meaningful to the underlying DeepWork state manager.
4. If `session_id` is omitted, native Pi tools MUST use the active Pi session identifier when available.
5. If no Pi session identifier is available, native Pi tools MUST generate a stable fallback identifier for the current process/session.

### PI-REQ-001.10: Post-Commit Review Reminder

1. The extension MUST observe Pi tool results for Bash or shell commands.
2. When a `git commit` command succeeds, the extension MUST inspect only the files in `HEAD`'s commit when deciding post-commit review context.
3. The post-commit review check MUST match committed files against change-cycle review rules using explicit-file semantics, including exclusion of catch-all rules.
4. If any committed-file review lacks a `.passed` marker, the extension MUST add context instructing the agent to ask the user whether they want to run `/review` for the committed changes.
5. If every committed-file review has already been marked as passed, or no non-catch-all review rule matches the committed files, the extension MUST add "No re-review needed - all reviews passed for committed files" context.
6. If last-commit file inspection or review checking fails after a successful `git commit`, the extension MUST fall back to the ask-user review reminder.
7. The post-commit reminder MUST be delivered through Pi-native tool-result augmentation rather than follow-up turns, automatic review runs, commit blocks, or Pi session state.

### PI-REQ-001.11: DeepSchema Write Validation

1. The extension MUST observe Pi file-write and file-edit tool results.
2. After a write or edit, the extension MUST invoke DeepSchema validation for the changed file when a matching schema exists.
3. The extension MUST deliver validation feedback to the agent through Pi-native tool-result augmentation or follow-up messages.
4. The extension MUST NOT block the original write or edit solely because DeepSchema validation produced feedback.
5. The extension MUST degrade gracefully when DeepSchema validation is unavailable or fails.

### PI-REQ-001.12: Error Handling

1. Native Pi tools MUST return structured errors that are understandable to the agent.
2. Extension event handlers MUST avoid throwing uncaught exceptions during Pi startup, session start, agent start, and tool-result handling.
3. External command failures MUST include command name, exit code, stdout, and stderr when safe to expose.
4. User-facing error messages MUST include an actionable next step when one is known.

### PI-REQ-001.13: Compatibility with Existing DeepWork Behavior

1. The native Pi extension MUST preserve DeepWork workflow semantics from the existing DeepWork implementation.
2. The native Pi extension MUST preserve DeepWork review-rule matching semantics from the existing DeepWork implementation.
3. The native Pi extension MUST preserve DeepSchema validation semantics from the existing DeepWork implementation.
4. The native Pi extension SHOULD share tests or fixtures with the existing DeepWork plugin where practical.
5. The native Pi extension MUST NOT fork behavior from DeepWork without a documented requirement or compatibility note.
