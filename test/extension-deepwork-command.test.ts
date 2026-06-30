import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../src/bridge.js");
});

describe("/deepwork prompt architecture", () => {
  // Covers PI-REQ-001.3.2 and PI-REQ-001.3.3: /deepwork is provided as prompt/skill instructions rather than procedural command code.
  it("does not register a hardcoded /deepwork extension command", async () => {
    const harness = await loadHarness();

    expect(Object.keys(harness.commands)).not.toContain("deepwork");
    expect(harness.commands).toHaveProperty("review");
    expect(harness.commands).toHaveProperty("record");
    expect(harness.bridge.getWorkflows).not.toHaveBeenCalled();
    expect(harness.bridge.startWorkflow).not.toHaveBeenCalled();
  });
});

async function loadHarness() {
  vi.resetModules();
  const bridge = {
    abortWorkflow: vi.fn(),
    finishedStep: vi.fn(),
    getActiveWorkflowStack: vi.fn(),
    getConfiguredReviews: vi.fn(),
    getNamedSchemas: vi.fn(),
    getPostCommitReviewContext: vi.fn(),
    getReviewInstructions: vi.fn(),
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
  const commands: Record<string, unknown> = {};
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: unknown) => {
      commands[name] = command;
    }),
    on: vi.fn(),
    sendMessage: vi.fn(),
    events: {
      on: vi.fn(() => () => undefined),
      emit: vi.fn(),
    },
  };

  deepworkPi(pi as never);
  return { bridge, commands, pi };
}
