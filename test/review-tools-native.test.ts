import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfiguredReviews, getReviewInstructions, markReviewAsPassed, parseReviewTasks } from "../src/bridge.js";

const tempDirs: string[] = [];
let previousDisableFallback: string | undefined;
let previousStandardSchemasDir: string | undefined;

beforeEach(async () => {
  previousDisableFallback = process.env.DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK;
  previousStandardSchemasDir = process.env.DEEPWORK_STANDARD_SCHEMAS_DIR;
  process.env.DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK = "1";
  process.env.DEEPWORK_STANDARD_SCHEMAS_DIR = await makeProject();
});

afterEach(async () => {
  restoreEnv("DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK", previousDisableFallback);
  restoreEnv("DEEPWORK_STANDARD_SCHEMAS_DIR", previousStandardSchemasDir);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("native review instruction generation", () => {
  // Covers PI-REQ-002.9.1, PI-REQ-002.9.5, PI-REQ-002.9.6, PI-REQ-002.9.8 through PI-REQ-002.9.9, PI-REQ-003.1.1 through PI-REQ-003.1.9, PI-REQ-003.2.1 through PI-REQ-003.2.6, PI-REQ-003.3.1 through PI-REQ-003.3.7, PI-REQ-003.6.1 through PI-REQ-003.6.4, PI-REQ-003.9.1 through PI-REQ-003.9.5, and PI-REQ-003.10.1 through PI-REQ-003.10.6.
  it("generates Pi-native review task output and instruction files for explicit files", async () => {
    const project = await makeProject();
    await writeReviewProject(project);

    const output = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const sanitized = sanitize(output, project);
    const tasks = parseReviewTasks(output);

    expect(sanitized).toContain("Run the following DeepWork review tasks.");
    expect(sanitized).toContain("description: Review typescript_rule");
    expect(sanitized).toContain("reviewer: typescript-reviewer");
    expect(sanitized).toContain("prompt_file: .deepwork/tmp/review_instructions/typescript_rule--src-app.ts--");
    expect(sanitized).toContain("rule_name: typescript_rule");
    expect(sanitized).toContain("files_to_review: src/app.ts");
    expect(sanitized).not.toContain("mcp__");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reviewId).toMatch(/^typescript_rule--src-app\.ts--/);
    expect(tasks[0].ruleName).toBe("typescript_rule");
    expect(tasks[0].filesToReview).toEqual(["src/app.ts"]);

    const prompt = await readFile(join(project, tasks[0].promptFile), "utf8");
    const sanitizedPrompt = sanitize(prompt, project);
    expect(sanitizedPrompt).toContain("# Review: typescript_rule — src/app.ts");
    expect(sanitizedPrompt).toContain("## Project Root");
    expect(sanitizedPrompt).toContain("<PROJECT>");
    expect(sanitizedPrompt).toContain("## Review Instructions");
    expect(sanitizedPrompt).toContain("Check TypeScript carefully.");
    expect(sanitizedPrompt).toContain("## Relevant File Contents");
    expect(sanitizedPrompt).toContain("## Files to Review");
    expect(sanitizedPrompt).toContain("- src/app.ts");
    expect(sanitizedPrompt).toContain("## Unchanged Matching Files");
    expect(sanitizedPrompt).toContain("- src/other.ts");
    expect(sanitizedPrompt).toContain("## All Changed Files");
    expect(sanitizedPrompt).toContain("## After Review");
    expect(sanitizedPrompt).toContain("deepwork_mark_review_as_passed");
    expect(sanitizedPrompt).toContain("This review was requested by the policy at `.deepreview:1`.");
    expect(sanitizedPrompt).not.toContain("mcp__");
    expect(sanitizedPrompt).not.toContain("@src/app.ts");
  });

  // Covers PI-REQ-002.9.7 and PI-REQ-003.3.1 through PI-REQ-003.3.4 by detecting changed files and writing deterministic prompt files when no explicit files are supplied.
  it("uses native changed-file detection when files are omitted", async () => {
    const project = await makeProject();
    await writeReviewProject(project);
    await git(project, "init");
    await git(project, "config", "user.email", "test@example.com");
    await git(project, "config", "user.name", "Test User");
    await git(project, "add", ".");
    await git(project, "commit", "-m", "base");
    await writeFile(join(project, "src", "app.ts"), "export const app = 2;\n");

    const output = await getReviewInstructions({}, { cwd: project });

    expect(output).toContain("description: Review typescript_rule");
    expect(output).toContain("description: Review catch_all");
    expect(parseReviewTasks(output)).toHaveLength(2);
  });

  // Covers PI-REQ-002.9.8, PI-REQ-002.12.6, and PI-REQ-003.5.1 through PI-REQ-003.5.2 by suppressing already-passed tasks while preserving pass markers.
  it("skips tasks with native .passed markers", async () => {
    const project = await makeProject();
    await writeReviewProject(project);
    const first = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const task = parseReviewTasks(first)[0];
    const reviewId = /review_id: ([^\n]+)/.exec(first)?.[1]?.trim();
    expect(reviewId).toBeTruthy();
    if (!reviewId) throw new Error("expected review_id in native review output");

    await markReviewAsPassed({ review_id: reviewId }, { cwd: project });
    const second = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });

    expect(second).toBe("No review tasks to execute.");
    expect(existsSync(join(project, task.promptFile))).toBe(true);
    expect(existsSync(join(project, ".deepwork", "tmp", "review_instructions", `${reviewId}.passed`))).toBe(true);
  });

  // Covers PI-REQ-002.9.13 and PI-REQ-003.3.4 by invalidating native pass-cache markers when reviewed file content changes and therefore receives a new deterministic review ID.
  it("re-runs passed reviews when reviewed file content changes", async () => {
    const project = await makeProject();
    await writeReviewProject(project);
    const first = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const firstReviewId = /review_id: ([^\n]+)/.exec(first)?.[1]?.trim();
    expect(firstReviewId).toBeTruthy();
    if (!firstReviewId) throw new Error("expected first review_id in native review output");

    await markReviewAsPassed({ review_id: firstReviewId }, { cwd: project });
    await writeFile(join(project, "src", "app.ts"), "export const app = 42;\n");
    const second = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const secondReviewId = /review_id: ([^\n]+)/.exec(second)?.[1]?.trim();

    expect(second).toContain("description: Review typescript_rule");
    expect(secondReviewId).toBeTruthy();
    expect(secondReviewId).not.toBe(firstReviewId);
    expect(existsSync(join(project, ".deepwork", "tmp", "review_instructions", `${firstReviewId}.passed`))).toBe(true);
  });

  // Covers PI-REQ-002.9.4, PI-REQ-003.1.11 through PI-REQ-003.1.13, and PI-REQ-003.10.1 by rendering inline-content review tasks with inline scope and no Files to Review section.
  it("renders inline-content tasks without a Files to Review section", async () => {
    const project = await makeProject();
    await writeReviewProject(project);
    const { buildInstructionFile, computeReviewId } = await import("../src/reviews/instructions.js");
    const baseTask = {
      ruleName: "inline_rule",
      filesToReview: [],
      instructions: "Check this text.",
      sourceLocation: ".deepreview:1",
      additionalFiles: [],
      inlineContent: "inline body",
      referenceFiles: [],
      cacheInvalidatesOn: "file_content" as const,
    };

    const markdown = await buildInstructionFile(baseTask, "inline_rule--inline--abc123", project);

    expect(computeReviewId({ ...baseTask, cacheInvalidatesOn: "changed_file_set" }, project)).not.toBe(computeReviewId({ ...baseTask, inlineContent: "changed inline body", cacheInvalidatesOn: "changed_file_set" }, project));
    expect(sanitize(markdown, project)).toContain("# Review: inline_rule — inline content");
    expect(markdown).toContain("## Content to Review\n\ninline body");
    expect(markdown).not.toContain("## Files to Review");
  });

  // Covers PI-REQ-003.7.1 through PI-REQ-003.7.5 by rendering successful and failed precomputed command output from commands run at the project root.
  it("renders precomputed context for successful and failed commands", async () => {
    const project = await makeProject();
    await mkdir(join(project, "scripts"), { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "app.ts"), "export const app = 1;\n");
    await writeFile(join(project, "scripts", "context.sh"), "#!/bin/sh\npwd\nprintf '\\ncontext ok\\n'\n");
    await writeFile(join(project, "scripts", "fail.sh"), "#!/bin/sh\necho bad >&2\nexit 7\n");
    await chmod(join(project, "scripts", "context.sh"), 0o755);
    await chmod(join(project, "scripts", "fail.sh"), 0o755);
    await writeFile(join(project, ".deepreview"), `precompute_ok:
  description: Precompute ok
  match:
    include: ["src/**/*.ts"]
  review:
    strategy: matches_together
    precomputed_info_for_reviewer_bash_command: scripts/context.sh
    instructions: Check with context.
precompute_fail:
  description: Precompute fail
  match:
    include: ["src/**/*.ts"]
  review:
    strategy: matches_together
    precomputed_info_for_reviewer_bash_command: scripts/fail.sh
    instructions: Check failed context.
`);

    const output = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const tasks = parseReviewTasks(output);
    expect(tasks).toHaveLength(2);

    const prompts = await Promise.all(tasks.map((task) => readFile(join(project, task.promptFile), "utf8")));
    expect(sanitize(prompts.join("\n---\n"), project)).toContain("## Precomputed Context");
    expect(prompts.join("\n---\n")).toContain("context ok");
    expect(prompts.join("\n---\n")).toContain("**Precompute command failed** (exit code 7):");
    expect(prompts.join("\n---\n")).toContain("bad");
  });

  // Covers PI-REQ-003.8.1 through PI-REQ-003.8.12 by enforcing reference-file inlining caps, truncation, omitted summaries, and unreadable markers.
  it("renders reference files with count caps, truncation, omitted summaries, and unreadable markers", async () => {
    const project = await makeProject();
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "refs"), { recursive: true });
    await writeFile(join(project, "src", "app.ts"), "export const app = 1;\n");
    const references: string[] = [];
    for (let i = 1; i <= 9; i += 1) {
      await writeFile(join(project, "refs", `ref${i}.md`), `reference ${i}\n`);
      references.push(`      - path: "refs/ref${i}.md"\n        description: "Reference ${i}"`);
    }
    references.push(`      - path: "refs/missing.md"\n        description: "Unreadable reference"`);
    await writeFile(join(project, "refs", "ref10.md"), "x".repeat(120_000));
    references.push(`      - path: "refs/ref10.md"\n        description: "Reference 10"`);
    references.push(`      - path: "refs/ref11.md"\n        description: "Omitted by count cap"`);
    await writeFile(join(project, ".deepreview"), `refs_rule:
  description: Reference review
  match:
    include: ["src/**/*.ts"]
  review:
    strategy: matches_together
    instructions: Check refs.
    reference_files:
${references.join("\n")}
`);

    const output = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const prompt = await readFile(join(project, parseReviewTasks(output)[0].promptFile), "utf8");

    expect(prompt).toContain("## Relevant File Contents");
    expect(prompt).toContain("### refs/ref1.md");
    expect(prompt).toContain("could not inline refs/missing.md");
    expect(prompt).toContain("... (truncated: file is 120000 bytes");
    expect(prompt).toContain("1 more reference file(s) omitted due to size/count caps: refs/ref11.md");
  });

  // Covers PI-REQ-003.5.1 through PI-REQ-003.5.2 by clearing stale instruction markdown on each native review generation run while preserving passed review artifacts.
  it("clears stale instruction markdown between review generation runs", async () => {
    const project = await makeProject();
    await writeReviewProject(project);
    const first = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const firstTask = parseReviewTasks(first)[0];
    expect(existsSync(join(project, firstTask.promptFile))).toBe(true);

    await writeFile(join(project, "src", "only-other.js"), "export const js = 1;\n");
    await writeFile(join(project, ".deepreview"), `javascript_rule:
  description: JavaScript review
  match:
    include: ["src/**/*.js"]
  review:
    strategy: individual
    instructions: Check JavaScript.
`);
    await getReviewInstructions({ files: ["src/only-other.js"] }, { cwd: project });

    expect(existsSync(join(project, firstTask.promptFile))).toBe(false);
    const remaining = await readdir(join(project, ".deepwork", "tmp", "review_instructions"));
    expect(remaining.every((name) => name.endsWith(".md") || name.endsWith(".passed"))).toBe(true);
  });

  // Covers PI-REQ-002.9.4, PI-REQ-002.9.11, PI-REQ-003.1.10, and PI-REQ-003.1.7 by rendering all_changed_files context and unchanged_matching_files only for matching unchanged files.
  it("handles all_changed_files and unchanged_matching_files edge cases", async () => {
    const project = await makeProject();
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "app.ts"), "export const app = 1;\n");
    await writeFile(join(project, "src", "other.ts"), "export const other = 1;\n");
    await writeFile(join(project, "src", "excluded.ts"), "export const excluded = 1;\n");
    await writeFile(join(project, "README.md"), "docs\n");
    await writeFile(join(project, ".deepreview"), `edge_rule:
  description: Edge review
  match:
    include: ["src/**/*.ts"]
    exclude: ["src/excluded.ts"]
  review:
    strategy: matches_together
    additional_context:
      all_changed_filenames: true
      unchanged_matching_files: true
    instructions: Check edge cases.
`);

    const output = await getReviewInstructions({ files: ["src/app.ts", "src/excluded.ts", "README.md"] }, { cwd: project });
    const prompt = await readFile(join(project, parseReviewTasks(output)[0].promptFile), "utf8");

    expect(prompt).toContain("## Files to Review\n\nUse Pi's file-reading tools");
    expect(prompt).toContain("- src/app.ts");
    expect(prompt).not.toContain("- src/excluded.ts\n\n## Unchanged Matching Files");
    expect(prompt).toContain("## Unchanged Matching Files");
    expect(prompt).toContain("- src/other.ts");
    expect(prompt).toContain("## All Changed Files");
    expect(prompt).toContain("- README.md");
    expect(prompt).toContain("- src/excluded.ts");
  });

  // Covers PI-REQ-002.9.8, PI-REQ-002.9.13, and PI-REQ-003.5.1 by separating PR-cadence rules and caching them by changed-file set.
  it("keeps pull-request reviews separate and supports changed-file-set cache invalidation", async () => {
    const project = await makeProject();
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "app.ts"), "export const app = 1;\n");
    await writeFile(join(project, ".deepreview"), `normal_rule:
  description: Normal review
  match:
    include: ["src/**/*.ts"]
  review:
    strategy: matches_together
    instructions: Check normal changes.
pr_summary:
  description: PR summary
  lifecycle:
    cadence: pull_request
  match:
    include: ["**/*"]
  review:
    strategy: all_changed_files
    cache:
      invalidates_on: changed_file_set
    instructions: Summarize this PR.
`);

    const normal = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    expect(normal).toContain("description: Review normal_rule");
    expect(normal).not.toContain("description: Review pr_summary");
    await expect(getConfiguredReviews({ only_rules_matching_files: ["src/app.ts"] }, { cwd: project })).resolves.toEqual([expect.objectContaining({ name: "normal_rule" })]);
    await expect(getConfiguredReviews({ only_rules_matching_files: ["src/app.ts"], review_cadence: "pull_request" }, { cwd: project })).resolves.toEqual([expect.objectContaining({ name: "pr_summary" })]);

    const firstPr = await getReviewInstructions({ files: ["src/app.ts"], review_cadence: "pull_request" }, { cwd: project });
    const firstReviewId = /review_id: ([^\n]+)/.exec(firstPr)?.[1]?.trim();
    expect(firstPr).toContain("description: Review pr_summary");
    expect(firstPr).not.toContain("description: Review normal_rule");
    expect(firstReviewId).toBeTruthy();
    if (!firstReviewId) throw new Error("expected first PR review_id");

    await markReviewAsPassed({ review_id: firstReviewId }, { cwd: project });
    await writeFile(join(project, "src", "app.ts"), "export const app = 2;\n");
    await expect(getReviewInstructions({ files: ["src/app.ts"], review_cadence: "pull_request" }, { cwd: project })).resolves.toBe("No review tasks to execute.");

    await writeFile(join(project, "src", "other.ts"), "export const other = 1;\n");
    const withNewFile = await getReviewInstructions({ files: ["src/app.ts", "src/other.ts"], review_cadence: "pull_request" }, { cwd: project });
    expect(withNewFile).toContain("description: Review pr_summary");
    expect(/review_id: ([^\n]+)/.exec(withNewFile)?.[1]?.trim()).not.toBe(firstReviewId);
  });

  // Covers PI-REQ-002.9.8 by returning a clear no-configuration message when there are no review rules.
  it("reports no rules without invoking the Python bridge", async () => {
    const project = await makeProject();

    await expect(getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project })).resolves.toBe("No .deepreview configuration files or DeepSchema definitions found.");
  });

  // Covers PI-REQ-002.9.4 and PI-REQ-003.4.3 by reporting invalid .deepreview files as structured review output instead of crashing.
  it("reports invalid .deepreview files in review output", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), "bad_rule:\n  description: Missing match and review\n");

    const output = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });

    expect(output).toContain("No valid review rules found. Parse errors:");
    expect(output).toContain("Schema validation failed");
  });
});

describe("native configured review listing", () => {
  // Covers PI-REQ-002.9.2, PI-REQ-002.9.10, PI-REQ-002.9.11, and PI-REQ-002.11.1 by returning JSON-serializable configured review metadata for all rules.
  it("lists all configured review rules with source locations", async () => {
    const project = await makeProject();
    await writeReviewProject(project);

    const result = await getConfiguredReviews({}, { cwd: project });

    expect(result).toEqual([
      {
        name: "typescript_rule",
        description: "TypeScript review",
        defining_file: ".deepreview:1",
        strategy: "individual",
        cadence: "change_cycle",
        cache_invalidates_on: "file_content",
        include_patterns: ["src/**/*.ts"],
        exclude_patterns: [],
        reviewer: "typescript-reviewer",
        all_changed_filenames: true,
        unchanged_matching_files: true,
      },
      {
        name: "catch_all",
        description: "Catch all review",
        defining_file: ".deepreview:19",
        strategy: "matches_together",
        cadence: "change_cycle",
        cache_invalidates_on: "file_content",
        include_patterns: ["**/*"],
        exclude_patterns: [],
        reviewer: null,
        all_changed_filenames: false,
        unchanged_matching_files: false,
      },
    ]);
  });

  // Covers PI-REQ-002.9.10, PI-REQ-002.9.11, and PI-REQ-001.10.4 by filtering configured reviews for explicit files and excluding catch-all rules.
  it("filters configured reviews for explicit files and excludes catch-all rules", async () => {
    const project = await makeProject();
    await writeReviewProject(project);

    const result = await getConfiguredReviews({ only_rules_matching_files: ["src/app.ts"] }, { cwd: project });

    expect(result).toEqual([expect.objectContaining({ name: "typescript_rule", description: "TypeScript review", defining_file: ".deepreview:1", strategy: "individual", reviewer: "typescript-reviewer" })]);
  });

  // Covers PI-REQ-002.9.10, PI-REQ-002.9.11, PI-REQ-001.10.4, and PI-REQ-002.13.2 by filtering configured reviews with subdirectory-relative patterns, exclusions, aliases, and catch-all removal.
  it("filters configured reviews exactly for subdirectory rules, aliases, excludes, and catch-all rules", async () => {
    const project = await makeProject();
    await mkdir(join(project, "src", "feature"), { recursive: true });
    await writeFile(join(project, "src", "feature", "keep.ts"), "export const keep = 1;\n");
    await writeFile(join(project, "src", "feature", "skip.ts"), "export const skip = 1;\n");
    await writeFile(join(project, "src", "feature", ".deepreview"), `feature_rule:
  description: Feature review
  match:
    include: ["*.ts"]
    exclude: ["skip.ts"]
  review:
    strategy: individual
    instructions: Check feature.
catch_all:
  description: Catch all
  match:
    include: ["**"]
  review:
    strategy: matches_together
    instructions: Check all.
`);

    await expect(getConfiguredReviews({ files: ["src/feature/keep.ts"] }, { cwd: project })).resolves.toEqual([
      expect.objectContaining({ name: "feature_rule", description: "Feature review", defining_file: "src/feature/.deepreview:1", strategy: "individual", include_patterns: ["*.ts"], exclude_patterns: ["skip.ts"] }),
    ]);
    await expect(getConfiguredReviews({ only_rules_matching_files: ["src/feature/skip.ts"] }, { cwd: project })).resolves.toEqual([]);
  });

  // Covers PI-REQ-002.9.11, PI-REQ-002.10.2, PI-REQ-002.12.3, and PI-REQ-003.8.2 by including DeepSchema-generated review rules in native configured-review listings.
  it("includes DeepSchema-generated review rules in configured reviews", async () => {
    const project = await makeProject();
    await mkdir(join(project, ".deepwork", "schemas", "component"), { recursive: true });
    await writeFile(join(project, ".deepwork", "schemas", "component", "deepschema.yml"), `summary: Component files
matchers:
  - "src/**/*.tsx"
requirements:
  no_default_export: "Components MUST NOT use default exports."
`);

    const result = await getConfiguredReviews({ only_rules_matching_files: ["src/App.tsx"] }, { cwd: project });

    expect(result).toEqual([
      expect.objectContaining({
        name: "component DeepSchema Compliance",
        description: "DeepSchema compliance review for component",
        defining_file: ".deepwork/schemas/component/deepschema.yml:0",
        strategy: "individual",
      }),
    ]);
  });

  // Covers PI-REQ-002.9.4, PI-REQ-002.9.8, PI-REQ-002.9.11, and PI-REQ-003.8.2 by generating native Pi review instructions from named and anonymous DeepSchemas.
  it("generates native review instructions for DeepSchema-generated rules", async () => {
    const project = await makeProject();
    await mkdir(join(project, ".deepwork", "schemas", "component"), { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "App.tsx"), "export function App() { return null; }\n");
    await writeFile(join(project, "src", "config.json"), "{}\n");
    await writeFile(join(project, "src", ".deepschema.config.json.yml"), `requirements:
  valid_config: "Config files MUST be valid for the application."
`);
    await writeFile(join(project, ".deepwork", "schemas", "component", "guide.md"), "Component guide\n");
    await writeFile(join(project, ".deepwork", "schemas", "component", "deepschema.yml"), `summary: Component files
instructions: Prefer explicit named exports.
matchers:
  - "src/**/*.tsx"
requirements:
  no_default_export: "Components MUST NOT use default exports."
references:
  - path: guide.md
    description: Component guide
examples:
  - path: example.tsx
    description: A good component
`);

    const output = await getReviewInstructions({ files: ["src/App.tsx", "src/config.json"] }, { cwd: project });
    const tasks = parseReviewTasks(output);
    expect(tasks).toHaveLength(2);
    expect(output).toContain("description: Review component DeepSchema Compliance");
    expect(output).toContain("description: Review config.json DeepSchema Compliance");

    const prompts = await Promise.all(tasks.map((task) => readFile(join(project, task.promptFile), "utf8")));
    const combined = prompts.join("\n---\n");
    expect(combined).toContain("src/App.tsx is an instance of component.");
    expect(combined).toContain("Components MUST NOT use default exports.");
    expect(combined).toContain("Example files available for reference");
    expect(combined).toContain("Component guide");
    expect(combined).toContain("src/config.json has requirements that it must follow.");
    expect(combined).toContain("Config files MUST be valid for the application.");
  });

  // Covers PI-REQ-002.9.11 and PI-REQ-002.12.3 by including parse errors in configured-review listings.
  it("includes invalid .deepreview parse errors in configured reviews", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), "bad_rule:\n  description: Missing match and review\n");

    const result = await getConfiguredReviews({}, { cwd: project }) as Array<{ name: string; description: string; defining_file: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("PARSE_ERROR:.deepreview");
    expect(result[0].description).toContain("Schema validation failed");
  });
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deepwork-pi-review-tools-"));
  tempDirs.push(dir);
  return dir;
}

async function writeReviewProject(project: string): Promise<void> {
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "app.ts"), "export const app = 1;\n");
  await writeFile(join(project, "src", "other.ts"), "export const other = 1;\n");
  await writeFile(join(project, ".deepreview"), `typescript_rule:
  description: TypeScript review
  match:
    include:
      - "src/**/*.ts"
  review:
    strategy: individual
    agent:
      pi: typescript-reviewer
    additional_context:
      all_changed_filenames: true
      unchanged_matching_files: true
    instructions: |
      Check TypeScript carefully.
    reference_files:
      - path: "src/other.ts"
        description: "Related TypeScript file"

catch_all:
  description: Catch all review
  match:
    include:
      - "**/*"
  review:
    strategy: matches_together
    instructions: Check everything.
`);
}

function sanitize(value: string, project: string): string {
  return value.replaceAll(project, "<PROJECT>");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function git(cwd: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`)));
  });
}
