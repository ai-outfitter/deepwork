## .deepreview File Format

YAML file at the repository root. Each top-level key is a rule name:

```yaml
rule_name:
  description: "Short description of what this rule checks."
  lifecycle:          # optional; defaults to change_cycle
    cadence: change_cycle | pull_request
  match:
    include:
      - "glob/pattern/**"
    exclude:           # optional
      - "glob/to/exclude/**"
  review:
    strategy: individual | matches_together | all_changed_files
    instructions: |
      Inline review instructions for the reviewer.
    cache:            # optional; defaults to file_content
      invalidates_on: file_content | changed_file_set
    precomputed_info_for_reviewer_bash_command: scripts/review-context.sh  # optional
    reference_files:   # optional; inline small support files into prompts
      - path: docs/style-guide.md
        description: Project style guide
    # OR reference an external file:
    # instructions:
    #   file: path/to/instructions.md
    additional_context:   # optional
      unchanged_matching_files: true   # include matching files even if not changed
      all_changed_filenames: true      # include list of all changed files
```

## Key Concepts

- **match.include**: Glob patterns that trigger this rule when matched files change
- **match.exclude**: Glob patterns to skip (optional). Files matching .gitignore
  rules (e.g. `__pycache__/`, `node_modules/`, `.env`) are excluded automatically,
  so they don't need to be listed here.
- **lifecycle.cadence**: `change_cycle` rules run during normal `/review` and quality gates. `pull_request` rules are separate PR-level reviews run with `/review --pr` or `deepwork_get_review_instructions` using `review_cadence: "pull_request"`.
- **strategy**: How to batch reviews:

  | Strategy | Reviewer sees | Best for |
  |----------|--------------|----------|
  | `individual` | One file at a time | Per-file linting, style checks |
  | `matches_together` | All matched files together | Cross-file consistency, migration safety |
  | `all_changed_files` | _Every_ changed file (tripwire) | Security audits, broad impact analysis |
- **cache.invalidates_on**: `file_content` re-runs passed reviews when reviewed file contents change. `changed_file_set` re-runs only when the reviewed changed-file set changes, which is useful for PR summaries and all-up final reviews.
- **precomputed_info_for_reviewer_bash_command**: Optional shell command resolved relative to the `.deepreview` file and executed from the project root before review prompts are written. Its stdout is injected as precomputed context. Use for deterministic summaries such as API graphs, route lists, schema summaries, or test-selection output. Commands time out after 60 seconds; failures and timeouts are rendered as prompt markers instead of aborting review generation. Avoid side effects, secrets, network dependencies, and interactive commands.
- **reference_files**: Optional support files to inline into the review prompt, resolved relative to the `.deepreview` file. Use for style guides, API contracts, schemas, examples, or domain rules. DeepWork caps inlined reference content by count and total bytes; oversized files are truncated or omitted with a marker, and missing/unreadable files are reported in the prompt instead of aborting review generation.
- **additional_context.unchanged_matching_files**: When true, the reviewer gets files
  matching include patterns even if they didn't change in this PR. Critical for
  document freshness checks — lets the reviewer see the doc even when only source
  files changed.

## Rule Naming Conventions

- Narrow rules (specific to one doc): `update_<doc_name_without_extension>`
- Wide rules (protecting multiple docs): `update_documents_relating_to_<watched_path_description>`
