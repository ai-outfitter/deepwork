# Agent Guidance

This is the standalone `deepwork` Pi package repository for `ai-outfitter/deepwork`.

## Scope

- Work only within this repository unless explicitly instructed otherwise.
- Do not commit generated artifacts such as `node_modules/`, `coverage/`, or `dist/`.
- Preserve the Pi package manifest resources: `pi.extensions`, `pi.skills`, and `pi.prompts` must continue to include the native extension, skills, and prompts.
- Keep the package identity as `deepwork` while preserving user-facing descriptions that explain this is the native DeepWork extension for Pi.

## Development

- Install dependencies with `npm ci`.
- Prefer narrow, behavior-preserving edits unless the task requests a broader change.
- Run the most relevant checks before committing:
  - `npm run check:package`
  - `npm run typecheck`
  - `npm test`
- If source behavior changes, update user-facing docs in `README.md`, `docs/`, `skills/`, or `prompts/` as appropriate.

## Review notes

- The package must not require `.mcp.json` or route Pi tools through MCP.
- Native tools are registered through `pi.registerTool()` and use `deepwork_*` names.
- Bundled jobs and schemas live in `standard_jobs/` and `standard_schemas/`.
