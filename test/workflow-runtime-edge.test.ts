import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abortWorkflow, finishedStep, getActiveWorkflowStack, getSessionJob, getWorkflows, registerSessionJob, startWorkflow, type BridgeOptions } from "../src/bridge.js";

const tempDirs: string[] = [];
let previousStandardJobsDir: string | undefined;

afterEach(async () => {
  restoreEnv("DEEPWORK_STANDARD_JOBS_DIR", previousStandardJobsDir);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  previousStandardJobsDir = process.env.DEEPWORK_STANDARD_JOBS_DIR;
  process.env.DEEPWORK_STANDARD_JOBS_DIR = await makeTempDir("empty-standard");
});

describe("native workflow runtime edge cases", () => {
  // Covers PI-REQ-001.9.4, PI-REQ-001.9.5, PI-REQ-002.4.4, PI-REQ-002.4.5, and PI-REQ-002.5.4 by verifying the bridge has a stable fallback session when no explicit session ID is provided.
  it("uses a stable fallback session ID when no session ID is supplied", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());
    const options = { cwd: project };

    const started = await startWorkflow({ goal: "fallback", job_name: "simple_job", workflow_name: "full", inputs: { seed: "x" } }, options);
    const next = await finishedStep({ outputs: { draft: "draft" }, quality_review_override_reason: "test" }, options);

    expect(json(started).begin_step.session_id).toBe("default");
    expect(json(next).status).toBe("next_step");
  });

  // Covers PI-REQ-002.14.1 through PI-REQ-002.14.12 by proving native Pi session jobs can be registered, retrieved, discovered, prioritized, and started in the same session only.
  it("registers, retrieves, and starts a session-scoped job", async () => {
    const project = await makeProject();
    const options = optionsFor(project, "session-job-session");
    const jobYaml = oneStepJobYaml("generated_job", "generated_output");
    await writeJob(project, "generated_job", oneStepJobYaml("generated_job", "local_output"));

    const registered = await registerSessionJob({ job_name: "generated_job", job_definition_yaml: jobYaml }, options);
    const retrieved = await getSessionJob({ job_name: "generated_job" }, options);
    const workflows = await getWorkflows(options);
    const started = await startWorkflow({ goal: "generated", job_name: "generated_job", workflow_name: "full" }, options);
    const complete = await finishedStep({ outputs: { generated_output: "done" }, quality_review_override_reason: "test" }, options);

    expect(json(registered)).toMatchObject({ status: "registered", job_name: "generated_job", session_id: "session-job-session" });
    expect(json(retrieved)).toMatchObject({ job_name: "generated_job", job_definition_yaml: jobYaml, session_id: "session-job-session" });
    expect(((json(workflows).jobs as Array<{ name: string }>)).map((job) => job.name)).toContain("generated_job");
    expect(json(started).begin_step.job_dir).toContain(".deepwork/tmp/sessions/pi/session-session-job-session/jobs/generated_job");
    expect(json(complete).status).toBe("workflow_complete");

    const otherStarted = await startWorkflow({ goal: "wrong session", job_name: "generated_job", workflow_name: "full" }, optionsFor(project, "other-session"));
    expect(json(otherStarted).begin_step.job_dir).toContain(".deepwork/jobs/generated_job");
    expect(json(otherStarted).begin_step.step_expected_outputs[0].name).toBe("local_output");
    await expect(getSessionJob({ job_name: "generated_job" }, optionsFor(project, "other-session"))).rejects.toThrow("not found for session 'other-session'");
  });

  // Covers PI-REQ-002.4.9, PI-REQ-002.5.11, PI-REQ-002.5.13, and PI-REQ-002.5.14 by verifying native state persists across separate tool calls.
  it("persists workflow stack state under .deepwork between tool calls", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());
    const options = optionsFor(project, "persist-session");

    await startWorkflow({ goal: "persist", job_name: "simple_job", workflow_name: "full", inputs: { seed: "x" } }, options);
    const state = JSON.parse(await readFile(join(project, ".deepwork", "state", "pi-workflows.json"), "utf8"));
    const next = await finishedStep({ outputs: { draft: "draft" }, quality_review_override_reason: "test" }, options);

    expect(state.sessions["persist-session"].stack[0].workflow_name).toBe("full");
    expect(json(next).begin_step.step_id).toBe("finalize");
  });

  // Covers PI-REQ-001.8.1 through PI-REQ-001.8.5 by restoring active workflow context from native state without shelling out to uvx.
  it("restores active workflow context from native state and status files", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());
    const options = optionsFor(project, "context-session");

    await startWorkflow({ goal: "restore me", job_name: "simple_job", workflow_name: "full", inputs: { seed: "x" } }, options);
    const status = JSON.parse(await readFile(join(project, ".deepwork", "status", "pi-workflows.json"), "utf8"));
    const context = await getActiveWorkflowStack(project);

    expect(status.session_id).toBe("context-session");
    expect(context).toContain("Session context-session");
    expect(context).toContain("Workflow: simple_job/full");
    expect(context).toContain("Goal: restore me");
    expect(context).toContain("Current step: draft");
    expect(context).toContain("Common job info:");
    expect(context).toContain("Draft from seed.");
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.8, PI-REQ-002.5.11, PI-REQ-002.5.12, PI-REQ-002.5.13, and PI-REQ-002.5.14 by advancing natively when quality gates have no reviews to run.
  it("advances and completes without override when no quality reviews are required", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());
    const options = optionsFor(project, "quality-pass-session");

    await startWorkflow({ goal: "quality pass", job_name: "simple_job", workflow_name: "full", inputs: { seed: "x" } }, options);
    const next = await finishedStep({ outputs: { draft: "draft" }, work_summary: "drafted" }, options);
    const complete = await finishedStep({ outputs: { final: "final" }, work_summary: "finalized" }, options);

    expect(json(next).status).toBe("next_step");
    expect(json(complete).status).toBe("workflow_complete");
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.8, PI-REQ-002.5.10, PI-REQ-002.5.11, and PI-REQ-003.9.5 by returning native needs_work feedback when output reviews are required.
  it("returns needs_work and writes native Pi review instructions for string output reviews", async () => {
    const project = await makeProject();
    await writeJob(project, "review_job", reviewedStringOutputJobYaml());
    const options = optionsFor(project, "quality-review-session");

    await startWorkflow({ goal: "review", job_name: "review_job", workflow_name: "full" }, options);
    const needsWork = await finishedStep({ outputs: { reviewed_text: "draft answer" }, work_summary: "drafted" }, options);
    const state = JSON.parse(await readFile(join(project, ".deepwork", "state", "pi-workflows.json"), "utf8"));

    expect(json(needsWork).status).toBe("needs_work");
    expect(json(needsWork).feedback).toContain("Quality reviews are required");
    expect(json(needsWork).feedback).toContain("deepwork_mark_review_as_passed");
    expect(json(needsWork).feedback).not.toContain("mcp__");
    expect(state.sessions["quality-review-session"].stack[0].current_step_index).toBe(0);
    expect(state.sessions["quality-review-session"].stack[0].quality_attempts.only_step).toBe(1);
  });

  // Covers PI-REQ-002.5.9 by skipping native quality-gate evaluation entirely when quality_review_override_reason is provided.
  it("quality_review_override_reason skips review and schema gates", async () => {
    const project = await makeProject();
    await writeJob(project, "review_job", reviewedStringOutputJobYaml());
    const options = optionsFor(project, "quality-override-session");

    await startWorkflow({ goal: "override", job_name: "review_job", workflow_name: "full" }, options);
    const complete = await finishedStep({ outputs: { reviewed_text: "draft answer" }, quality_review_override_reason: "user accepted risk" }, options);

    expect(json(complete).status).toBe("workflow_complete");
  });

  // Covers PI-REQ-002.5.8 and PI-REQ-002.5.10 by returning needs_work feedback for output JSON schema validation failures.
  it("returns needs_work when file_path output JSON schema validation fails", async () => {
    const project = await makeProject();
    await writeJob(project, "schema_job", schemaValidatedOutputJobYaml());
    await writeFile(join(project, "artifact.yml"), "valid: false\n");
    const options = optionsFor(project, "schema-quality-session");

    await startWorkflow({ goal: "schema", job_name: "schema_job", workflow_name: "full" }, options);
    const needsWork = await finishedStep({ outputs: { artifact: "artifact.yml" }, work_summary: "wrote artifact" }, options);

    expect(json(needsWork).status).toBe("needs_work");
    expect(json(needsWork).feedback).toContain("JSON schema validation failed");
    expect(json(needsWork).feedback).toContain("Fix these issues and call finished_step again");
  });

  // Covers PI-REQ-002.6.2 and PI-REQ-002.6.3 by allowing omitted optional outputs while still enforcing required outputs.
  it("allows optional outputs to be omitted and rejects missing required outputs", async () => {
    const project = await makeProject();
    await writeJob(project, "optional_job", optionalOutputJobYaml());
    const options = optionsFor(project, "optional-session");

    await startWorkflow({ goal: "optional", job_name: "optional_job", workflow_name: "full" }, options);
    const complete = await finishedStep({ outputs: { required_text: "done" }, quality_review_override_reason: "test" }, options);

    expect(json(complete).status).toBe("workflow_complete");
    expect(json(complete).all_outputs).toEqual({ required_text: "done" });

    await startWorkflow({ goal: "missing", job_name: "optional_job", workflow_name: "full" }, optionsFor(project, "missing-session"));
    await expect(finishedStep({ outputs: {}, quality_review_override_reason: "test" }, optionsFor(project, "missing-session"))).rejects.toThrow("Missing required output: required_text");
  });

  // Covers PI-REQ-002.6.4, PI-REQ-002.6.5, and PI-REQ-002.6.7 by validating file_path output values and existence relative to the project root.
  it("accepts existing file_path outputs and rejects missing file paths", async () => {
    const project = await makeProject();
    await writeJob(project, "file_job", fileOutputJobYaml());
    await writeFile(join(project, "result.txt"), "ok");
    const options = optionsFor(project, "file-session");

    await startWorkflow({ goal: "file", job_name: "file_job", workflow_name: "full" }, options);
    const complete = await finishedStep({ outputs: { artifact: "result.txt" }, quality_review_override_reason: "test" }, options);
    expect(json(complete).status).toBe("workflow_complete");

    const missingOptions = optionsFor(project, "missing-file-session");
    await startWorkflow({ goal: "file", job_name: "file_job", workflow_name: "full" }, missingOptions);
    await expect(finishedStep({ outputs: { artifact: "missing.txt" }, quality_review_override_reason: "test" }, missingOptions)).rejects.toThrow("file path does not exist");
  });

  // Covers PI-REQ-002.6.4, PI-REQ-002.6.6, and PI-REQ-002.6.7 by returning structured errors for output type mismatches.
  it("rejects output type mismatches", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());
    const options = optionsFor(project, "type-session");

    await startWorkflow({ goal: "types", job_name: "simple_job", workflow_name: "full", inputs: { seed: "x" } }, options);

    await expect(finishedStep({ outputs: { draft: ["not", "string"] }, quality_review_override_reason: "test" }, options)).rejects.toThrow("Output 'draft' must be a string");
  });

  // Covers PI-REQ-002.4.8 by rejecting workflows with no executable steps during native startup validation.
  it("rejects no-step workflows before creating a session", async () => {
    const project = await makeProject();
    await writeJob(project, "empty_job", emptyWorkflowJobYaml());

    await expect(startWorkflow({ goal: "empty", job_name: "empty_job", workflow_name: "full" }, optionsFor(project, "empty-session"))).rejects.toThrow("must NOT have fewer than 1 items");
  });

  // Covers PI-REQ-002.4.7 by auto-selecting the only workflow when the requested workflow name does not match.
  it("auto-selects the only workflow when workflow_name is wrong but unambiguous", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());

    const started = await startWorkflow({ goal: "auto", job_name: "simple_job", workflow_name: "wrong", inputs: { seed: "x" } }, optionsFor(project, "auto-session"));

    expect(json(started).stack).toEqual([{ workflow: "simple_job/full", step: "draft" }]);
  });

  // Covers PI-REQ-002.4.14, PI-REQ-002.7.7, and PI-REQ-002.8.13 by preserving nested workflow stack behavior when a workflow starts another workflow in the same session.
  it("supports nested workflow stacks and resumes the parent when the child aborts", async () => {
    const project = await makeProject();
    await writeJob(project, "simple_job", simpleJobYaml());
    await writeJob(project, "child_job", oneStepJobYaml("child_job", "child_output"));
    const options = optionsFor(project, "nested-session");

    await startWorkflow({ goal: "parent", job_name: "simple_job", workflow_name: "full", inputs: { seed: "x" } }, options);
    const child = await startWorkflow({ goal: "child", job_name: "child_job", workflow_name: "full" }, options);
    const aborted = await abortWorkflow({ explanation: "child done elsewhere" }, options);

    expect(json(child).stack).toEqual([
      { workflow: "simple_job/full", step: "draft" },
      { workflow: "child_job/full", step: "only_step" },
    ]);
    expect(json(aborted).resumed_workflow).toBe("simple_job/full");
    expect(json(aborted).resumed_step).toBe("draft");
  });
});

async function makeProject(): Promise<string> {
  const project = await makeTempDir("runtime-edge");
  await mkdir(join(project, ".deepwork", "jobs"), { recursive: true });
  return project;
}

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `deepwork-pi-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeJob(project: string, name: string, yaml: string): Promise<void> {
  const dir = join(project, ".deepwork", "jobs", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "job.yml"), yaml);
}

function optionsFor(cwd: string, sessionId: string): BridgeOptions {
  return { cwd, sessionId };
}

function json(value: unknown): Record<string, any> {
  return value as Record<string, any>;
}

function simpleJobYaml(): string {
  return `name: simple_job
summary: Simple runtime edge job
step_arguments:
  - name: seed
    description: Seed input
    type: string
  - name: draft
    description: Draft output
    type: string
  - name: final
    description: Final output
    type: string
workflows:
  full:
    summary: Full workflow
    common_job_info_provided_to_all_steps_at_runtime: Shared context.
    steps:
      - name: draft
        instructions: Draft from seed.
        inputs:
          seed: {}
        outputs:
          draft: {}
      - name: finalize
        instructions: Finalize draft.
        inputs:
          draft: {}
        outputs:
          final: {}
`;
}

function optionalOutputJobYaml(): string {
  return `name: optional_job
summary: Optional output job
step_arguments:
  - name: required_text
    description: Required output
    type: string
  - name: optional_text
    description: Optional output
    type: string
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce optional outputs.
        outputs:
          required_text: {}
          optional_text:
            required: false
`;
}

function fileOutputJobYaml(): string {
  return `name: file_job
summary: File output job
step_arguments:
  - name: artifact
    description: Artifact path
    type: file_path
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce a file.
        outputs:
          artifact: {}
`;
}

function reviewedStringOutputJobYaml(): string {
  return `name: review_job
summary: Reviewed string output job
step_arguments:
  - name: reviewed_text
    description: Reviewed text
    type: string
    review:
      strategy: individual
      instructions: |
        Confirm the text is acceptable.
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce reviewed text.
        outputs:
          reviewed_text: {}
`;
}

function schemaValidatedOutputJobYaml(): string {
  return `name: schema_job
summary: Schema validated output job
step_arguments:
  - name: artifact
    description: Artifact path
    type: file_path
    json_schema:
      type: object
      required:
        - valid
      properties:
        valid:
          const: true
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce an artifact.
        outputs:
          artifact: {}
`;
}

function emptyWorkflowJobYaml(): string {
  return `name: empty_job
summary: Empty workflow job
step_arguments:
  - name: result
    description: Result
    type: string
workflows:
  full:
    summary: Empty workflow
    steps: []
`;
}

function oneStepJobYaml(jobName: string, outputName: string): string {
  return `name: ${jobName}
summary: One step job
step_arguments:
  - name: ${outputName}
    description: Output
    type: string
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce output.
        outputs:
          ${outputName}: {}
`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
