import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import deepworkPi from "../src/index.js";
import { getActiveWorkflowStack, getReviewInstructions, markReviewAsPassed, parseReviewTasks, startWorkflow } from "../src/bridge.js";

const tempDirs: string[] = [];
let previousStandardSchemasDir: string | undefined;
let previousDisableReviewFallback: string | undefined;

type RegisteredHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> | unknown;

beforeEach(async () => {
  previousStandardSchemasDir = process.env.DEEPWORK_STANDARD_SCHEMAS_DIR;
  previousDisableReviewFallback = process.env.DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK;
  process.env.DEEPWORK_STANDARD_SCHEMAS_DIR = await makeTempDir("empty-standard-schemas");
  process.env.DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK = "1";
});

afterEach(async () => {
  restoreEnv("DEEPWORK_STANDARD_SCHEMAS_DIR", previousStandardSchemasDir);
  restoreEnv("DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK", previousDisableReviewFallback);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("extension event handlers", () => {
  // Covers PI-REQ-002.7.6 and PI-REQ-002.7.7 by aborting workflow state tied to the old Pi session when /clear or another new-session flow replaces the session.
  it("aborts the current DeepWork workflow when Pi starts a new session", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());
    await startWorkflow({ goal: "clear stale workflow", job_name: "simple_job", workflow_name: "full", inputs: { seed: "x" } }, { cwd: project, sessionId: "test-session" });
    const pi = createPiHarness();
    deepworkPi(pi.api);

    await pi.handlers.session_shutdown?.({ reason: "new" }, ctx(project));

    expect(await getActiveWorkflowStack(project)).toBeNull();
  });

  // Covers PI-REQ-001.11.1 through PI-REQ-001.11.5 and PI-REQ-001.12.2 by augmenting write tool results with native DeepSchema feedback without blocking the write.
  it("augments write tool results with native DeepSchema feedback", async () => {
    const project = await makeProject();
    await writeNamedSchema(project, "component", `summary: Component files
instructions: Prefer named exports.
matchers:
  - "src/**/*.tsx"
requirements:
  named_exports: "Components MUST use named exports."
`);
    await writeFile(join(project, "src", "App.tsx"), "export default function App() { return null; }\n");
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "write",
      input: { file_path: "src/App.tsx" },
      content: [{ type: "text", text: "write ok" }],
      details: { existing: true },
    }, ctx(project));

    expect(result).toMatchObject({ details: { existing: true } });
    const output = result as { content: Array<{ type: string; text: string }>; details: { deepwork?: { deepschemaContext?: string } } };
    expect(output.content[0].text).toBe("write ok");
    expect(output.content.at(-1)?.text).toContain("DeepSchema guidance for src/App.tsx");
    expect(output.content.at(-1)?.text).toContain("Components MUST use named exports.");
    expect(output.details.deepwork?.deepschemaContext).toContain("DeepSchema guidance for src/App.tsx");
  });

  // Covers PI-REQ-001.11.1 through PI-REQ-001.11.5 and PI-REQ-001.12.2 by augmenting edit tool results when the input uses Pi's path-style file field.
  it("augments edit tool results when the file path is supplied as path", async () => {
    const project = await makeProject();
    await writeNamedSchema(project, "docs", `instructions: Keep docs concise.
matchers:
  - "docs/**/*.md"
`);
    await mkdir(join(project, "docs"), { recursive: true });
    await writeFile(join(project, "docs", "guide.md"), "# Guide\n");
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "edit",
      input: { path: "docs/guide.md" },
      content: [],
      details: {},
    }, ctx(project));

    const output = result as { content: Array<{ type: string; text: string }> };
    expect(output.content.at(-1)?.text).toContain("DeepSchema guidance for docs/guide.md");
    expect(output.content.at(-1)?.text).toContain("Keep docs concise.");
  });

  // Covers PI-REQ-001.10.1 through PI-REQ-001.10.6 by appending old-style post-commit context for HEAD files without creating a follow-up turn.
  it("appends a scoped review reminder for unpassed committed files without sending a follow-up", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), `typescript_rule:
  description: TypeScript review
  match:
    include:
      - "src/**/*.ts"
  review:
    strategy: individual
    instructions: Check TypeScript carefully.
`);
    await git(project, ["init"]);
    await git(project, ["add", ".deepreview"]);
    await git(project, ["commit", "-m", "add review rules"]);
    await writeFile(join(project, "src", "app.ts"), "export const value = 1;\n");
    await git(project, ["add", "src/app.ts"]);
    await git(project, ["commit", "-m", "add app"]);
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "bash",
      input: { command: "git commit -m test" },
      content: [{ type: "text", text: "commit ok" }],
      details: { exit_code: 0 },
    }, ctx(project));

    expect(await getReviewInstructions({}, { cwd: project })).toBe("No changed files detected.");
    expect(pi.messages).toEqual([]);
    const output = result as { content: Array<{ type: string; text: string }>; details: { deepwork?: { postCommitReviewContext?: string } } };
    expect(output.content[0].text).toBe("commit ok");
    expect(output.content.at(-1)?.text).toContain("ask_user_question");
    expect(output.content.at(-1)?.text).toContain("/review");
    expect(output.content.at(-1)?.text).toContain("quick quality check");
    expect(output.content.at(-1)?.text).not.toContain("recently");
    expect(output.details.deepwork?.postCommitReviewContext).toContain("ask_user_question");
  });

  // Covers PI-REQ-001.10.2 through PI-REQ-001.10.6 by proving dirty worktree review tasks no longer drive post-commit reminders.
  it("does not use unrelated current changes to decide post-commit review context", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), `typescript_rule:
  description: TypeScript review
  match:
    include:
      - "src/**/*.ts"
  review:
    strategy: individual
    instructions: Check TypeScript carefully.
`);
    await git(project, ["init"]);
    await git(project, ["add", ".deepreview"]);
    await git(project, ["commit", "-m", "add review rules"]);
    await writeFile(join(project, "src", "app.ts"), "export const value = 1;\n");
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "bash",
      input: { command: "git commit -m test" },
      content: [],
      details: { exit_code: 0 },
    }, ctx(project));

    expect(parseReviewTasks(await getReviewInstructions({}, { cwd: project }))).toHaveLength(1);
    expect(pi.messages).toEqual([]);
    const output = result as { content: Array<{ type: string; text: string }>; details: { deepwork?: { postCommitReviewContext?: string } } };
    expect(output.content.at(-1)?.text).toContain("No re-review needed - all reviews passed for committed files");
    expect(output.details.deepwork?.postCommitReviewContext).toContain("No re-review needed");
  });

  // Covers PI-REQ-001.10.2, PI-REQ-001.10.4, PI-REQ-001.10.5, and PI-REQ-001.12.2 by treating committed files with no non-catch-all reviews as already passed.
  it("appends all-passed context for unrelated committed files", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), `typescript_rule:
  description: TypeScript review
  match:
    include:
      - "src/**/*.ts"
  review:
    strategy: individual
    instructions: Check TypeScript carefully.
catch_all:
  description: Catch-all review
  match:
    include:
      - "**"
  review:
    strategy: matches_together
    instructions: General review.
`);
    await git(project, ["init"]);
    await git(project, ["add", ".deepreview"]);
    await git(project, ["commit", "-m", "add review rules"]);
    await mkdir(join(project, "docs"), { recursive: true });
    await writeFile(join(project, "docs", "guide.md"), "# Guide\n");
    await git(project, ["add", "docs/guide.md"]);
    await git(project, ["commit", "-m", "docs"]);
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "bash",
      input: { command: "git commit -m docs" },
      content: [],
      details: { exit_code: 0 },
    }, ctx(project));

    expect(pi.messages).toEqual([]);
    const output = result as { content: Array<{ type: string; text: string }> };
    expect(output.content.at(-1)?.text).toContain("No re-review needed - all reviews passed for committed files");
  });

  // Covers PI-REQ-001.10.2 through PI-REQ-001.10.5 by avoiding prompts for deleted files that the normal /review path cannot inspect.
  it("appends all-passed context for deletion-only commits", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), `typescript_rule:
  description: TypeScript review
  match:
    include:
      - "src/**/*.ts"
  review:
    strategy: individual
    instructions: Check TypeScript carefully.
`);
    await git(project, ["init"]);
    await git(project, ["add", ".deepreview"]);
    await git(project, ["commit", "-m", "add review rules"]);
    await writeFile(join(project, "src", "removed.ts"), "export const removed = true;\n");
    await git(project, ["add", "src/removed.ts"]);
    await git(project, ["commit", "-m", "add removed file"]);
    await git(project, ["rm", "src/removed.ts"]);
    await git(project, ["commit", "-m", "remove file"]);
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "bash",
      input: { command: "git commit -m remove" },
      content: [],
      details: { exit_code: 0 },
    }, ctx(project));

    expect(parseReviewTasks(await getReviewInstructions({}, { cwd: project }))).toHaveLength(0);
    expect(pi.messages).toEqual([]);
    const output = result as { content: Array<{ type: string; text: string }>; details: { deepwork?: { postCommitReviewContext?: string } } };
    expect(output.content.at(-1)?.text).toContain("No re-review needed - all reviews passed for committed files");
    expect(output.details.deepwork?.postCommitReviewContext).toContain("No re-review needed");
  });

  // Covers PI-REQ-001.10.5 and PI-REQ-002.9.13 by appending all-passed context when committed-file reviews have pass markers.
  it("appends all-passed context when committed-file reviews have pass markers", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), `typescript_rule:
  description: TypeScript review
  match:
    include:
      - "src/**/*.ts"
  review:
    strategy: individual
    instructions: Check TypeScript carefully.
`);
    await git(project, ["init"]);
    await git(project, ["add", ".deepreview"]);
    await git(project, ["commit", "-m", "add review rules"]);
    await writeFile(join(project, "src", "app.ts"), "export const value = 1;\n");
    await git(project, ["add", "src/app.ts"]);
    await git(project, ["commit", "-m", "add app"]);
    const instructions = await getReviewInstructions({ files: ["src/app.ts"] }, { cwd: project });
    const reviewId = instructions.match(/review_id: (\S+)/)?.[1];
    expect(reviewId).toBeTruthy();
    await markReviewAsPassed({ review_id: reviewId ?? "" }, { cwd: project });
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "bash",
      input: { command: "git commit -m app" },
      content: [],
      details: { exit_code: 0 },
    }, ctx(project));

    expect(pi.messages).toEqual([]);
    const output = result as { content: Array<{ type: string; text: string }>; details: { deepwork?: { postCommitReviewContext?: string } } };
    expect(output.content.at(-1)?.text).toContain("No re-review needed - all reviews passed for committed files");
    expect(output.details.deepwork?.postCommitReviewContext).toContain("No re-review needed");
  });

  // Covers PI-REQ-001.10.2 and PI-REQ-001.12.2 by ignoring failed git commit commands.
  it("does not send a review reminder for failed git commit commands", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), `typescript_rule:
  description: TypeScript review
  match:
    include:
      - "src/**/*.ts"
  review:
    strategy: individual
    instructions: Check TypeScript carefully.
`);
    await git(project, ["init"]);
    await git(project, ["add", ".deepreview"]);
    await git(project, ["commit", "-m", "add review rules"]);
    await writeFile(join(project, "src", "app.ts"), "export const value = 1;\n");
    await git(project, ["add", "src/app.ts"]);
    await git(project, ["commit", "-m", "add app"]);
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "bash",
      input: { command: "git commit -m failed" },
      content: [],
      details: { exit_code: 1 },
    }, ctx(project));

    expect(result).toBeUndefined();
    expect(pi.messages).toEqual([]);
  });

  // Covers PI-REQ-001.10.2 and PI-REQ-001.12.2 by falling back to the reminder when HEAD file inspection fails.
  it("appends the review reminder when last-commit inspection fails", async () => {
    const project = await makeProject();
    const pi = createPiHarness();
    deepworkPi(pi.api);

    const result = await pi.handlers.tool_result?.({
      toolName: "bash",
      input: { command: "git commit -m test" },
      content: [],
      details: {},
    }, ctx(project));

    expect(pi.messages).toEqual([]);
    const output = result as { content: Array<{ type: string; text: string }> };
    expect(output.content.at(-1)?.text).toContain("ask_user_question");
  });
});

function createPiHarness(): {
  api: never;
  handlers: Record<string, RegisteredHandler>;
  messages: Array<{ message: { customType?: string; content?: string; display?: boolean }; options: unknown }>;
} {
  const handlers: Record<string, RegisteredHandler> = {};
  const messages: Array<{ message: { customType?: string; content?: string; display?: boolean }; options: unknown }> = [];
  return {
    handlers,
    messages,
    api: {
      registerTool() {},
      registerCommand() {},
      on(name: string, handler: RegisteredHandler) {
        handlers[name] = handler;
      },
      sendMessage(message: { customType?: string; content?: string; display?: boolean }, options: unknown) {
        messages.push({ message, options });
      },
      events: {
        on() {
          return () => {};
        },
        emit() {},
      },
    } as never,
  };
}

function ctx(project: string): Record<string, unknown> {
  return {
    cwd: project,
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify() {} },
  };
}

async function makeProject(): Promise<string> {
  const project = await makeTempDir("project");
  await mkdir(join(project, "src"), { recursive: true });
  return project;
}

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `deepwork-pi-extension-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeJob(project: string, name: string, yaml: string): Promise<void> {
  const dir = join(project, ".deepwork", "jobs", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "job.yml"), yaml);
}

function simpleJobYaml(): string {
  return `name: simple_job
summary: Simple extension event job
step_arguments:
  - name: seed
    description: Seed input
    type: string
  - name: draft
    description: Draft output
    type: string
workflows:
  full:
    summary: Full workflow
    steps:
      - name: draft
        instructions: Draft from seed.
        inputs:
          seed: {}
        outputs:
          draft: {}
`;
}

async function writeNamedSchema(projectRoot: string, name: string, content: string): Promise<void> {
  const dir = join(projectRoot, ".deepwork", "schemas", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "deepschema.yml"), content);
}

function git(projectRoot: string, args: string[]): Promise<string> {
  const gitArgs = ["-c", "user.name=DeepWork Test", "-c", "user.email=deepwork@example.invalid", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn("git", gitArgs, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args.join(" ")} failed with code ${code}`));
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
