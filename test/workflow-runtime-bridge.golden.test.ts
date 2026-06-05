import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortWorkflow,
  finishedStep,
  goToStep,
  startWorkflow,
  type BridgeOptions,
  type JsonObject,
  type JsonValue,
} from "../src/bridge.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(testDir, "fixtures", "projects", "runtime");
const goldenRoot = join(testDir, "golden", "workflow-runtime-bridge");
const tempDirs: string[] = [];

type RuntimeSnapshot =
  | { ok: true; result: JsonValue }
  | { ok: false; name: string; message: string; error_type?: string };

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("workflow runtime compatibility goldens", () => {
  // Covers PI-REQ-002.4.1 through PI-REQ-002.4.16 and PI-REQ-002.11.1 by preserving the start-workflow runtime contract during TypeScript migration.
  it("captures deepwork_start_workflow response shape", async () => {
    await expectRuntimeGolden("start-workflow", async ({ options }) => {
      return capture(() => startWorkflow(startParams(), options));
    });
  });

  // Covers PI-REQ-002.5.1 through PI-REQ-002.5.4, PI-REQ-002.5.7, PI-REQ-002.5.9, PI-REQ-002.5.11, PI-REQ-002.5.13, and PI-REQ-002.5.14 by preserving successful step advancement with quality-gate override.
  it("captures deepwork_finished_step next_step response shape", async () => {
    await expectRuntimeGolden("finished-step-next", async ({ options }) => {
      await startWorkflow(startParams(), options);
      return capture(() => finishedStep(firstStepParams(), options));
    });
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.9, PI-REQ-002.5.11, PI-REQ-002.5.12, and PI-REQ-002.5.14 by preserving workflow completion with merged outputs and post-workflow instructions.
  it("captures deepwork_finished_step workflow_complete response shape", async () => {
    await expectRuntimeGolden("finished-step-complete", async ({ options }) => {
      await startWorkflow(startParams(), options);
      await finishedStep(firstStepParams(), options);
      return capture(() => finishedStep(secondStepParams(), options));
    });
  });

  // Covers PI-REQ-002.7.1 through PI-REQ-002.7.7 by preserving abort response fields and stack behavior.
  it("captures deepwork_abort_workflow response shape", async () => {
    await expectRuntimeGolden("abort-workflow", async ({ options }) => {
      await startWorkflow(startParams(), options);
      return capture(() => abortWorkflow({ explanation: "golden abort" }, options));
    });
  });

  // Covers PI-REQ-002.8.1 through PI-REQ-002.8.5 and PI-REQ-002.8.8 through PI-REQ-002.8.13 by preserving backwards navigation and invalidated-step behavior.
  it("captures deepwork_go_to_step backwards response shape", async () => {
    await expectRuntimeGolden("go-to-step-back", async ({ options }) => {
      await startWorkflow(startParams(), options);
      await finishedStep(firstStepParams(), options);
      return capture(() => goToStep({ step_id: "draft" }, options));
    });
  });

  // Covers PI-REQ-002.4.6, PI-REQ-002.5.5, PI-REQ-002.6.1, PI-REQ-002.6.7, PI-REQ-002.8.7, and PI-REQ-001.12.1 by preserving structured runtime errors for failure cases.
  it("captures workflow runtime structured error shapes", async () => {
    await expectRuntimeGolden("runtime-errors", async ({ cwd }) => {
      const missingJob = await capture(() => startWorkflow({ goal: "x", job_name: "missing", workflow_name: "full" }, optionsFor(cwd, "missing-job-session")));
      const noSessionFinish = await capture(() => finishedStep({ outputs: {} }, optionsFor(cwd, "no-session")));
      const activeOptions = optionsFor(cwd, "runtime-error-session");
      await startWorkflow(startParams(), activeOptions);
      const unknownOutput = await capture(() => finishedStep({ outputs: { bogus: "x" }, quality_review_override_reason: "golden skip" }, activeOptions));
      const forwardGoTo = await capture(() => goToStep({ step_id: "finalize" }, activeOptions));

      return {
        ok: true,
        result: {
          missingJob,
          noSessionFinish,
          unknownOutput,
          forwardGoTo,
        },
      };
    });
  });
});

async function expectRuntimeGolden(
  name: string,
  run: (context: { cwd: string; options: BridgeOptions }) => Promise<RuntimeSnapshot>,
): Promise<void> {
  const { projectRoot, cleanupEnv } = await prepareProject();
  try {
    const snapshot = sanitize(await run({ cwd: projectRoot, options: optionsFor(projectRoot, "runtime-golden-session") }), projectRoot);
    const goldenPath = join(goldenRoot, `${name}.json`);

    if (process.env.UPDATE_RUNTIME_GOLDEN) {
      await mkdir(goldenRoot, { recursive: true });
      await writeFile(goldenPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    }

    const expected = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(snapshot).toEqual(expected);
  } finally {
    cleanupEnv();
  }
}

async function prepareProject(): Promise<{ projectRoot: string; cleanupEnv: () => void }> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "deepwork-pi-runtime-")));
  tempDirs.push(tempRoot);
  await cp(fixtureRoot, tempRoot, { recursive: true });
  const standardJobsDir = join(tempRoot, "standard-jobs-empty");
  await mkdir(standardJobsDir, { recursive: true });

  const previousStandardJobsDir = process.env.DEEPWORK_STANDARD_JOBS_DIR;
  process.env.DEEPWORK_STANDARD_JOBS_DIR = standardJobsDir;
  return {
    projectRoot: tempRoot,
    cleanupEnv: () => {
      if (previousStandardJobsDir === undefined) {
        delete process.env.DEEPWORK_STANDARD_JOBS_DIR;
      } else {
        process.env.DEEPWORK_STANDARD_JOBS_DIR = previousStandardJobsDir;
      }
    },
  };
}

function optionsFor(cwd: string, sessionId: string): BridgeOptions {
  return { cwd, sessionId };
}

function startParams(): JsonObject {
  return {
    goal: "Exercise runtime fixture",
    job_name: "runtime_job",
    workflow_name: "full",
    inputs: { seed: "alpha" },
  };
}

function firstStepParams(): JsonObject {
  return {
    outputs: { draft: "draft value" },
    work_summary: "drafted",
    quality_review_override_reason: "golden test",
  };
}

function secondStepParams(): JsonObject {
  return {
    outputs: { final: "final value" },
    work_summary: "finalized",
    quality_review_override_reason: "golden test",
  };
}

async function capture(run: () => Promise<JsonValue>): Promise<RuntimeSnapshot> {
  try {
    return { ok: true, result: await run() };
  } catch (error) {
    const details = typeof error === "object" && error !== null && "details" in error ? (error as { details?: { error_type?: unknown } }).details : undefined;
    return {
      ok: false,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(typeof details?.error_type === "string" ? { error_type: details.error_type } : {}),
    };
  }
}

function sanitize(value: unknown, projectRoot: string): unknown {
  if (typeof value === "string") return value.replaceAll(projectRoot, "<PROJECT>");
  if (Array.isArray(value)) return value.map((item) => sanitize(item, projectRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, projectRoot)]));
  }
  return value;
}
