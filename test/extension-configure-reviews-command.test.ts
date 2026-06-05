import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Message = { message: { customType: string; content: string; display: boolean }; options: unknown };
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../src/bridge.js");
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("/configure-reviews command UX", () => {
  // Covers PI-REQ-001.5.2, PI-REQ-001.5.3, PI-REQ-001.5.4, and PI-REQ-001.5.5 by registering the command, loading configure-reviews guidance, inspecting existing rules, and validating configured reviews through native tools.
  it("registers /configure-reviews and summarizes existing .deepreview configuration without MCP language", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), "root_rule:\n  description: Root rule\n");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", ".deepreview"), "src_rule:\n  description: Src rule\n");
    const harness = await loadHarness({ project });

    await harness.commands["configure-reviews"].handler("", harness.ctx);

    expect(harness.bridge.getConfiguredReviews).toHaveBeenCalledWith({}, expect.objectContaining({ cwd: project }));
    expect(harness.bridge.getReviewInstructions).not.toHaveBeenCalled();
    expect(harness.messages).toHaveLength(1);
    const content = harness.messages[0].message.content;
    expect(harness.messages[0].message.customType).toBe("deepwork-configure-reviews");
    expect(content).toContain("Configure DeepWork Reviews for this Pi project.");
    expect(content).toContain("Existing .deepreview files:");
    expect(content).toContain("- .deepreview");
    expect(content).toContain("- src/.deepreview");
    expect(content).toContain("Configured review rules currently visible to DeepWork:");
    expect(content).toContain("typescript_rule");
    expect(content).toContain("Before creating or modifying `.deepreview` files, read `deepwork/docs/README_REVIEWS.md`");
    expect(content).toContain("deepwork_get_configured_reviews");
    expect(content).toContain("deepwork_get_review_instructions");
    expect(content).not.toMatch(/mcp__/i);
    expect(content).not.toMatch(/MCP tool/i);
  });

  // Covers PI-REQ-001.5.5, PI-REQ-002.9.6, PI-REQ-002.9.10, and PI-REQ-003.11.4 by passing file scope to native configured-review and review-instruction generation.
  it("uses command file filters to preview native review validation for a concrete scope", async () => {
    const project = await makeProject();
    const harness = await loadHarness({ project, reviewInstructions: "Run the following DeepWork review tasks.\ndescription: Review docs_rule\n  reviewer: docs-reviewer\n  prompt_file: .deepwork/tmp/review_instructions/docs.md" });

    await harness.commands["configure-reviews"].handler('--files docs/guide.md,"src/a b.ts"', harness.ctx);

    expect(harness.bridge.getConfiguredReviews).toHaveBeenCalledWith(
      { only_rules_matching_files: ["docs/guide.md", "src/a b.ts"] },
      expect.objectContaining({ cwd: project }),
    );
    expect(harness.bridge.getReviewInstructions).toHaveBeenCalledWith(
      { files: ["docs/guide.md", "src/a b.ts"] },
      expect.objectContaining({ cwd: project }),
    );
    const content = harness.messages[0].message.content;
    expect(content).toContain("Validation scope: docs/guide.md, src/a b.ts");
    expect(content).toContain("Review instruction preview for the requested scope:");
    expect(content).toContain("description: Review docs_rule");
    expect(content).toContain("After editing .deepreview files, validate with deepwork_get_configured_reviews and deepwork_get_review_instructions using autostart_reviews_if_possible: false");
    expect(content).not.toMatch(/mcp__/i);
  });

  // Covers PI-REQ-001.5.2, PI-REQ-001.12.4, and PI-REQ-002.9.11 by guiding first-time setup when no .deepreview files exist and surfacing configured-review inspection errors actionably.
  it("guides first-time setup and reports configured-review inspection errors", async () => {
    const project = await makeProject();
    const harness = await loadHarness({ project, configuredError: new Error("invalid .deepreview") });

    await harness.commands["configure-reviews"].handler("", harness.ctx);

    const content = harness.messages[0].message.content;
    expect(content).toContain("- None found. Create a .deepreview file at the repository root or near the files it governs.");
    expect(content).toContain("Could not inspect configured reviews: Error: invalid .deepreview");
    expect(content).toContain("Ask clarifying questions only when the desired policy is unclear.");
    expect(content).not.toMatch(/mcp__/i);
  });
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deepwork-pi-configure-reviews-"));
  tempDirs.push(dir);
  return dir;
}

async function loadHarness(options: { project: string; configuredError?: Error; reviewInstructions?: string }) {
  vi.resetModules();
  const bridge = {
    abortWorkflow: vi.fn(),
    finishedStep: vi.fn(),
    getActiveWorkflowStack: vi.fn(),
    getConfiguredReviews: vi.fn(async () => {
      if (options.configuredError) throw options.configuredError;
      return [{ name: "typescript_rule", description: "TypeScript review", defining_file: ".deepreview:1" }];
    }),
    getNamedSchemas: vi.fn(),
    getReviewInstructions: vi.fn(async () => options.reviewInstructions ?? "No review tasks to execute."),
    getWorkflows: vi.fn(),
    goToStep: vi.fn(),
    hasApplicableReviews: vi.fn(),
    markReviewAsPassed: vi.fn(),
    parseReviewTasks: vi.fn(() => []),
    runDeepSchemaWriteHook: vi.fn(),
    startWorkflow: vi.fn(),
  };
  vi.doMock("../src/bridge.js", () => bridge);

  const { default: deepworkPi } = await import("../src/index.js");
  const commands: Record<string, { handler: CommandHandler }> = {};
  const messages: Message[] = [];
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands[name] = command;
    }),
    on: vi.fn(),
    sendMessage: vi.fn((message: Message["message"], sendOptions: unknown) => {
      messages.push({ message, options: sendOptions });
    }),
    events: {
      on: vi.fn(() => () => undefined),
      emit: vi.fn(),
    },
  };

  deepworkPi(pi as never);
  return {
    bridge,
    commands,
    ctx: { cwd: options.project, sessionManager: { getSessionId: () => "session-1" }, ui: { notify: vi.fn() } },
    messages,
  };
}
