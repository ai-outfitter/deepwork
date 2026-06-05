# Native Bridge Notes

The native Pi package exposes DeepWork behavior through Pi extension APIs, not MCP.

## Boundary

- Pi-facing commands and tools live in TypeScript under `extensions/` and are exported through `src/index.ts`.
- Normal Pi-facing operation MUST NOT require `.mcp.json`, register MCP tools, start a DeepWork MCP server, or proxy DeepWork through MCP.
- `src/bridge.ts` is a compatibility boundary for the remaining Python fallback paths. It SHOULD keep fallback use centralized while native TypeScript parity is expanded.

## Current native paths

The following paths are now first-pass native TypeScript:

- workflow discovery/parsing and `deepwork_get_workflows`
- workflow runtime/state/status for start, finish, abort, go-to-step, stack persistence, and active context restoration
- output validation and first-pass quality gates
- `.deepreview` and DeepSchema-generated workflow quality gates for `file_path` outputs
- review discovery/parsing/matching/git changed-file detection
- first-pass native `deepwork_get_review_instructions` and `deepwork_get_configured_reviews`, including richer structured review metadata for native `/review` summaries and configured-review listing
- native review dispatch through the optional `pi-subagents` slash event bridge: when available, `/review` and `deepwork_get_review_instructions` launch async fresh-context reviewer subagents by default and return reduced launch/status context instead of duplicating full prompt content; when `deepwork_get_review_instructions` receives `autostart_reviews_if_possible: false` or subagents are unavailable, they fall back to presenting sequential review tasks. DeepWork also listens for explicit pass markers from its launched review subagents so a reviewer can still record a passing review when the child process cannot access `deepwork_mark_review_as_passed` directly
- native `deepwork_mark_review_as_passed`
- DeepSchema discovery, named schema listing, generated review rules, and write/edit feedback
- commit review reminder matching the current native review-instruction scope, staying silent when no review tasks would run
- lightweight native recording notes under `.deepwork/tmp/recordings/<session_id>.json` consumed by `/deepwork learn`

## Remaining Python fallback paths

Python fallback remains available for compatibility while parity is strengthened. In particular:

- review instruction/configured-review calls can fall back to Python if native review generation throws, unless `DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK=1` is set
- DeepSchema write/edit feedback can fall back to the existing DeepWork hook if the native write-hook path throws, unless `DEEPWORK_PI_DISABLE_DEEPSCHEMA_PYTHON_FALLBACK=1` is set

This fallback does not start, register, proxy, or require an MCP server for Pi. Some imported Python modules still have `mcp` in their package path because they are existing DeepWork implementation modules, not because Pi is using MCP as its interface.

## Quality-gate review ID compatibility note

Policy quality-gate review IDs for `.deepreview` and DeepSchema-generated rules intentionally use the same deterministic ID scheme as native review instruction generation, so native pass markers are shared between workflow quality gates and `deepwork_get_review_instructions`.

Built-in workflow-output review tasks and process-requirement quality tasks currently use deterministic native IDs that are stable for native `.passed` markers, but they do not exactly match Python's standard review ID format. Native tests document that these IDs suppress unchanged outputs and invalidate when inline output content changes. Exact Python ID compatibility for those built-in quality tasks has not yet been established as a requirement. If cross-runtime pass-marker compatibility for built-in workflow-output or process-requirement reviews becomes required, update the native ID scheme and tests before removing the Python fallback.

## Preferred fallback order

1. Native TypeScript implementation.
2. Direct reusable DeepWork Python/library API through the centralized bridge only when parity is not yet native.
3. Purpose-built JSON CLI surface.
4. Existing CLI commands only when structured output is available.
5. Human-readable output parsing only as an explicitly documented compatibility fallback.
