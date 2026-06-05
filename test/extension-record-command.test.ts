import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";

type Message = { message: { customType: string; content: string; display: boolean }; options: unknown };
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const workflowsWithAuthoring = {
  jobs: [
    {
      name: "deepwork_jobs",
      summary: "Create and repair DeepWork jobs",
      workflows: [
        { name: "new_job", summary: "Create a new DeepWork job", how_to_invoke: "Call deepwork_start_workflow" },
      ],
    },
  ],
  errors: [],
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../src/bridge.js");
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("/record and /deepwork learn UX", () => {
  // Covers PI-REQ-001.3.2, PI-REQ-001.3.5, PI-REQ-001.6.1, and PI-REQ-001.6.7 by registering /record and loading native record skill guidance.
  it("registers /record and starts a native Pi recording flow without MCP language", async () => {
    const harness = await loadHarness();

    await harness.commands.record.handler("weekly status report", harness.ctx);

    expect(harness.messages).toHaveLength(1);
    const content = harness.messages[0].message.content;
    expect(harness.messages[0].message.customType).toBe("deepwork-record");
    expect(content).toContain("Got it — recording workflow: **weekly status report**.");
    expect(content).toContain("Use Pi normally while capturing the user's process as repeatable steps.");
    expect(content).toContain("run `/deepwork learn`");
    expect(content).toContain(".deepwork/tmp/recordings/session-1.json");
    expect(content).toContain("Recent Pi session context captured for learn");
    expect(content).toContain("user: I need a repeatable weekly report");
    expect(content).toContain(".deepwork/jobs/");
    expect(content).toContain("What would you like to call this workflow?");
    expect(content).not.toMatch(/mcp__/i);
    expect(content).not.toMatch(/MCP tool/i);
  });

  // Covers PI-REQ-001.3.2 and PI-REQ-001.12.4 by prompting for a workflow name when /record has no arguments.
  it("prompts for a workflow name when /record is invoked without a name", async () => {
    const harness = await loadHarness();

    await harness.commands.record.handler("", harness.ctx);

    const content = harness.messages[0].message.content;
    expect(content).toContain("First, ask the user what they would like to call this workflow");
    expect(content).toContain("Track inputs, outputs, decisions");
    expect(content).toContain("Recording note saved");
    expect(content).not.toMatch(/mcp__/i);
  });

  // Covers PI-REQ-001.3.2, PI-REQ-001.9.1, and PI-REQ-001.9.4 by persisting lightweight recording state keyed to the active Pi session for later learn handoff.
  it("persists a lightweight recording note under .deepwork/tmp for /deepwork learn", async () => {
    const harness = await loadHarness();

    await harness.commands.record.handler("release checklist", harness.ctx);

    const state = JSON.parse(await readFile(join(harness.cwd, ".deepwork", "tmp", "recordings", "session-1.json"), "utf8"));
    expect(state).toMatchObject({
      version: 1,
      session_id: "session-1",
      workflow_name: "release checklist",
      invocation_context: "release checklist",
    });
    expect(state.session_context).toContain("user: I need a repeatable weekly report");
    expect(state.guidance_summary).toContain("What would you like to call this workflow?");
  });
});

async function loadHarness(options: { workflows?: unknown; startResult?: unknown } = {}) {
  vi.resetModules();
  const cwd = await mkdtemp(join(tmpdir(), "deepwork-pi-record-command-"));
  tempDirs.push(cwd);
  const bridge = {
    abortWorkflow: vi.fn(),
    finishedStep: vi.fn(),
    getActiveWorkflowStack: vi.fn(),
    getConfiguredReviews: vi.fn(),
    getNamedSchemas: vi.fn(),
    getReviewInstructions: vi.fn(),
    getWorkflows: vi.fn(async () => options.workflows ?? workflowsWithAuthoring),
    goToStep: vi.fn(),
    hasApplicableReviews: vi.fn(),
    markReviewAsPassed: vi.fn(),
    parseReviewTasks: vi.fn(() => []),
    runDeepSchemaWriteHook: vi.fn(),
    startWorkflow: vi.fn(async () => options.startResult ?? { begin_step: { session_id: "session-1", step_id: "define" }, stack: [] }),
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
    sendUserMessage: vi.fn(),
    events: {
      on: vi.fn(() => () => undefined),
      emit: vi.fn(),
    },
  };

  deepworkPi(pi as never);
  return {
    bridge,
    commands,
    cwd,
    pi,
    ctx: {
      cwd,
      sessionManager: {
        getSessionId: () => "session-1",
        buildSessionContext: () => ({
          messages: [
            { role: "user", content: "I need a repeatable weekly report" },
            { role: "assistant", content: "We gathered metrics, drafted the summary, and checked links." },
          ],
        }),
      },
      ui: { notify: vi.fn() },
    },
    messages,
  };
}
