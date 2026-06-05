---
name: deepschema
description: "Create and manage DeepSchemas with validation and review generation"
---

# DeepSchema

DeepSchemas define file-level contracts for a project. They support write-time validation, review generation during `/review`, and workflow quality gates. This native Pi package uses Pi tools directly; it does not use MCP.

## What DeepSchemas Provide

- Structural validation through JSON Schema.
- Optional verification commands for checks that tools can run deterministically.
- Semantic RFC 2119 requirements for judgment-based review rules.
- Generated review tasks for matching files.

## Named Schemas

Named schemas live under `.deepwork/schemas/<name>/`:

```text
.deepwork/schemas/api_endpoint/
  deepschema.yml
  endpoint.schema.json
  examples/
  references/
```

Example `deepschema.yml`:

```yaml
summary: "Configuration files for service endpoints."
instructions: |
  Keep endpoint definitions explicit and safe for production use.

matchers:
  - "**/*.endpoint.yml"

requirements:
  no-secrets: "Endpoint files MUST NOT contain secrets or credentials."
  stable-names: "Endpoint names MUST be stable identifiers, not display labels."

json_schema_path: "endpoint.schema.json"
verification_bash_command:
  - "yamllint -d relaxed"
```

## Anonymous Schemas

Anonymous schemas sit next to one-off target files. Use them only when a schema is specific to a single file and is not expected to generalize.

## Creating or Updating a Schema

1. Decide whether the schema is named or anonymous.
2. Put exact structural constraints in JSON Schema when possible.
3. Put deterministic command checks in `verification_bash_command` when appropriate.
4. Use `requirements` only for semantic rules that require judgment or cross-file context.
5. Add examples and references when they help reviewers evaluate changes.
6. Call `deepwork_get_named_schemas` to verify named schema discovery.
7. If a matching file changed, call `deepwork_get_review_instructions` with `autostart_reviews_if_possible: false` to verify generated review rules appear without launching reviewers.

## Design Guidance

- Prefer precise JSON Schema constraints over prose requirements.
- Keep requirements concrete, testable, and written with RFC 2119 keywords.
- Avoid duplicating the same rule in JSON Schema and requirements unless the prose adds judgment or rationale.
- Keep schema references small enough to be useful in review prompts.

## Native Tool

Use `deepwork_get_named_schemas` to list discovered named schemas and confirm matcher coverage.
