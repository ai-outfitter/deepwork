# DeepWork

`deepwork` is the native Pi package for DeepWork workflows, DeepWork Reviews, and DeepSchema.

This package is intentionally native to Pi: it does **not** require `.mcp.json`, does **not** start a DeepWork MCP server, and does **not** route Pi tools through MCP. Runtime implementation work reuses existing DeepWork behavior through native TypeScript implementations and a narrow compatibility bridge where behavior has not yet been ported.

## Install from GitHub

From a Pi project, install the package with:

```bash
pi install git:github.com/applepi-ai/deepwork
```

Then reload Pi resources if Pi is already running:

```text
/reload
```

The package name is `deepwork`; it provides the native DeepWork extension and packaged skills/prompts for Pi.

## Local development

Clone this repository and install dependencies:

```bash
git clone https://github.com/applepi-ai/deepwork.git
cd deepwork
npm ci
```

From a Pi project, install the local checkout with:

```bash
pi install /path/to/deepwork -l
```

Run available checks from the package checkout:

```bash
npm run check:package
npm run typecheck
npm test
```

## Native Pi resources

The package manifest declares:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

The extension entry point registers `/review`, `/deepwork_review`, `/configure-reviews`, `/record`, the native `deepwork_*` tools listed below, session context restoration, commit review reminders, and DeepSchema write feedback hooks. `/deepwork` itself is provided as a prompt/skill-style resource at `prompts/deepwork.md`; it tells the agent to call `deepwork_get_workflows`, infer the appropriate workflow, and start it with native tools.

## Required native tool surface

The implementation requirements define these Pi-native tools:

- `deepwork_get_workflows`
- `deepwork_start_workflow`
- `deepwork_finished_step`
- `deepwork_abort_workflow`
- `deepwork_go_to_step`
- `deepwork_get_review_instructions`
- `deepwork_get_configured_reviews`
- `deepwork_mark_review_as_passed`
- `deepwork_get_named_schemas`

These tools are registered with `pi.registerTool()` and do not call MCP tools or require an MCP server. `deepwork_get_workflows` uses native TypeScript workflow discovery/parsing and includes bundled standard jobs from `standard_jobs/` unless `DEEPWORK_STANDARD_JOBS_DIR` overrides the source. Other runtime operations still use a first-pass one-shot Python compatibility bridge that reuses existing DeepWork modules; future work should replace those compatibility shims with native TypeScript implementations.

## Package resources

- `src/` contains the native Pi extension entry point, bridge, tools, workflow runtime helpers, review helpers, and DeepSchema helpers.
- `extensions/` contains Pi command/tool/lifecycle registration.
- `skills/` contains packaged Pi skills for DeepWork, reviews, DeepSchema, DeepPlan, record, and onboarding flows.
- `prompts/` contains the `/deepwork` prompt resource.
- `standard_jobs/` and `standard_schemas/` contain bundled DeepWork jobs and DeepSchema definitions used by the extension.
- `docs/` contains user-facing review and bridge documentation.
- `doc/specs/deepwork-pi/` contains native Pi requirements retained from the implementation source.

## Package status

Implemented so far:

- `package.json` with standalone Pi package metadata for `applepi-ai/deepwork`
- `src/index.ts` Pi extension entry point
- `extensions/index.ts` native Pi tool, command, and lifecycle registration
- `src/bridge.ts` centralized compatibility bridge for operations not yet ported to TypeScript
- `src/workflows/discovery.ts` native TypeScript workflow discovery and parsing for `deepwork_get_workflows`
- `tsconfig.json` TypeScript project config
- `doc/specs/deepwork-pi/` native Pi requirements
- `skills/` native Pi skill set
- `standard_jobs/` bundled DeepWork standard jobs, including `deepwork_jobs/new_job`, `deepwork_jobs/learn`, `deepwork_jobs/repair`, `deepwork_jobs/shared_jobs`, `deepwork_reviews/*`, and `deepplan/create_deep_plan`
- `docs/` native Pi review/bridge reference docs

## Requirements

Primary requirements are in:

- `doc/specs/deepwork-pi/PI-REQ-001-native-pi-extension.md`
- `doc/specs/deepwork-pi/PI-REQ-002-native-pi-tools.md`
- `doc/specs/deepwork-pi/PI-REQ-003-native-pi-reviews.md`

## Reuse guidance

The native Pi package should preserve existing DeepWork workflow, review, DeepSchema, and state-management semantics instead of forking behavior.
