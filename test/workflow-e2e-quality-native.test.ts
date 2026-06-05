import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishedStep, getActiveWorkflowStack, markReviewAsPassed, startWorkflow, type BridgeOptions } from "../src/bridge.js";

const tempDirs: string[] = [];
let previousStandardJobsDir: string | undefined;
let previousStandardSchemasDir: string | undefined;

afterEach(async () => {
  restoreEnv("DEEPWORK_STANDARD_JOBS_DIR", previousStandardJobsDir);
  restoreEnv("DEEPWORK_STANDARD_SCHEMAS_DIR", previousStandardSchemasDir);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  previousStandardJobsDir = process.env.DEEPWORK_STANDARD_JOBS_DIR;
  previousStandardSchemasDir = process.env.DEEPWORK_STANDARD_SCHEMAS_DIR;
  process.env.DEEPWORK_STANDARD_JOBS_DIR = await makeTempDir("empty-standard-jobs");
  process.env.DEEPWORK_STANDARD_SCHEMAS_DIR = await makeTempDir("empty-standard-schemas");
});

describe("native workflow end-to-end quality gates", () => {
  // Covers PI-REQ-001.8.1 through PI-REQ-001.8.5, PI-REQ-002.5.7, PI-REQ-002.5.10 through PI-REQ-002.5.14, PI-REQ-002.9.13, and PI-REQ-003.3.4 by exercising repeated finished_step calls, pass-marker suppression, early-step quality-gated advancement, and native status/context restoration in one multi-step workflow.
  it("advances a multi-step workflow after repeated quality-gate calls create and then honor pass markers", async () => {
    const project = await makeProject();
    await writeMultiArtifactJob(project);
    await writeDeepReview(project, "matches_together");
    await writeArtifacts(project);
    const options = optionsFor(project, "e2e-quality-session");

    const started = json(await startWorkflow({ goal: "produce artifacts", job_name: "multi_artifact_job", workflow_name: "full" }, options));
    const firstNeedsWork = json(await finishedStep(firstStepOutputs(), options));
    const repeatedNeedsWork = json(await finishedStep(firstStepOutputs("repeated without passes"), options));
    const reviewIds = reviewIdsFromFeedback(firstNeedsWork.feedback as string);
    for (const review_id of reviewIds) await markReviewAsPassed({ review_id }, options);
    const advanced = json(await finishedStep(firstStepOutputs("passed review"), options));
    const status = JSON.parse(await readFile(join(project, ".deepwork", "status", "pi-workflows.json"), "utf8"));
    const context = await getActiveWorkflowStack(project);
    const complete = json(await finishedStep({ outputs: { summary: "done" }, work_summary: "summarized" }, options));

    expect(started.begin_step.step_id).toBe("produce");
    expect(firstNeedsWork.status).toBe("needs_work");
    expect(repeatedNeedsWork.status).toBe("needs_work");
    expect(reviewIds).toHaveLength(1);
    expect(reviewIdsFromFeedback(repeatedNeedsWork.feedback as string)).toEqual(reviewIds);
    expect(advanced.status).toBe("next_step");
    expect(advanced.begin_step.step_id).toBe("summarize");
    expect(status.session_id).toBe("e2e-quality-session");
    expect(status.stack).toEqual([{ workflow: "multi_artifact_job/full", step: "summarize" }]);
    expect(context).toContain("Session e2e-quality-session");
    expect(context).toContain("Workflow: multi_artifact_job/full");
    expect(context).toContain("Current step: summarize");
    expect(context).toContain("Summarize both artifacts");
    expect(complete.status).toBe("workflow_complete");
    expect(complete.all_outputs).toEqual({ artifacts: ["artifact-a.txt", "artifact-b.txt"], summary: "done" });
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.10, PI-REQ-003.1.7 through PI-REQ-003.1.10, PI-REQ-003.3.6, PI-REQ-003.10.1 through PI-REQ-003.10.3, and PI-REQ-003.10.5 by rendering one grouped quality-gate task for multiple workflow output files with the matches_together strategy.
  it("renders one grouped quality-gate prompt for multiple output files with matches_together", async () => {
    const project = await makeProject();
    await writeMultiArtifactJob(project);
    await writeDeepReview(project, "matches_together");
    await writeArtifacts(project);
    const options = optionsFor(project, "matches-together-session");

    await startWorkflow({ goal: "group artifacts", job_name: "multi_artifact_job", workflow_name: "full" }, options);
    const result = json(await finishedStep(firstStepOutputs(), options));
    const promptFiles = promptFilesFromFeedback(result.feedback as string, project);
    const content = await readFile(promptFiles[0], "utf8");

    expect(result.status).toBe("needs_work");
    expect(promptFiles).toHaveLength(1);
    expect(content).toContain("## Files to Review");
    expect(content).toContain("- artifact-a.txt");
    expect(content).toContain("- artifact-b.txt");
    expect(content).toContain("Read both workflow output artifacts as one grouped policy review.");
    expect(content).not.toContain("mcp__");
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.10, PI-REQ-003.1.7, PI-REQ-003.3.3, PI-REQ-003.3.6, and PI-REQ-003.10.1 through PI-REQ-003.10.3 by rendering separate quality-gate tasks for each changed workflow output file with the individual strategy.
  it("renders one quality-gate prompt per output file with individual strategy", async () => {
    const project = await makeProject();
    await writeMultiArtifactJob(project);
    await writeDeepReview(project, "individual");
    await writeArtifacts(project);
    const options = optionsFor(project, "individual-session");

    await startWorkflow({ goal: "individual artifacts", job_name: "multi_artifact_job", workflow_name: "full" }, options);
    const result = json(await finishedStep(firstStepOutputs(), options));
    const promptFiles = promptFilesFromFeedback(result.feedback as string, project);
    const contents = await Promise.all(promptFiles.map((file) => readFile(file, "utf8")));

    expect(result.status).toBe("needs_work");
    expect(promptFiles).toHaveLength(2);
    expect(contents.some((content) => content.includes("# Review: artifact_policy — artifact-a.txt"))).toBe(true);
    expect(contents.some((content) => content.includes("# Review: artifact_policy — artifact-b.txt"))).toBe(true);
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.10, PI-REQ-003.1.10, PI-REQ-003.2.4, PI-REQ-003.3.6, and PI-REQ-003.10.1 through PI-REQ-003.10.3 by preserving all_changed_files grouped context for multiple workflow output files.
  it("renders all changed workflow output files in all_changed_files quality-gate prompts", async () => {
    const project = await makeProject();
    await writeMultiArtifactJob(project);
    await writeDeepReview(project, "all_changed_files");
    await writeArtifacts(project);
    const options = optionsFor(project, "all-changed-files-session");

    await startWorkflow({ goal: "all changed artifacts", job_name: "multi_artifact_job", workflow_name: "full" }, options);
    const result = json(await finishedStep(firstStepOutputs(), options));
    const promptFiles = promptFilesFromFeedback(result.feedback as string, project);
    const content = await readFile(promptFiles[0], "utf8");

    expect(result.status).toBe("needs_work");
    expect(promptFiles).toHaveLength(1);
    expect(content).toContain("## Files to Review");
    expect(content).toContain("- artifact-a.txt");
    expect(content).toContain("- artifact-b.txt");
    expect(content).toContain("## All Changed Files");
    expect(content).toContain("- artifact-a.txt");
    expect(content).toContain("- artifact-b.txt");
  });
});

async function makeProject(): Promise<string> {
  const project = await makeTempDir("workflow-e2e-quality");
  await mkdir(join(project, ".deepwork", "jobs"), { recursive: true });
  return project;
}

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `deepwork-pi-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeMultiArtifactJob(project: string): Promise<void> {
  const dir = join(project, ".deepwork", "jobs", "multi_artifact_job");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "job.yml"), `name: multi_artifact_job
summary: Multi artifact quality-gated workflow
step_arguments:
  - name: artifacts
    description: Artifact files
    type: file_path
  - name: summary
    description: Final summary
    type: string
workflows:
  full:
    summary: Produce artifacts and summarize them
    common_job_info_provided_to_all_steps_at_runtime: Shared workflow context for quality-gate tests.
    steps:
      - name: produce
        instructions: Produce both artifacts.
        outputs:
          artifacts: {}
      - name: summarize
        instructions: Summarize both artifacts.
        inputs:
          artifacts: {}
        outputs:
          summary: {}
`);
}

async function writeArtifacts(project: string): Promise<void> {
  await writeFile(join(project, "artifact-a.txt"), "artifact A\n");
  await writeFile(join(project, "artifact-b.txt"), "artifact B\n");
}

async function writeDeepReview(project: string, strategy: "individual" | "matches_together" | "all_changed_files"): Promise<void> {
  await writeFile(join(project, ".deepreview"), `artifact_policy:
  description: Review workflow output artifacts.
  match:
    include:
      - "artifact-*.txt"
  review:
    strategy: ${strategy}
    additional_context:
      all_changed_filenames: true
    instructions: |
      Read both workflow output artifacts as one grouped policy review.
`);
}

function firstStepOutputs(workSummary = "produced artifacts") {
  return { outputs: { artifacts: ["artifact-a.txt", "artifact-b.txt"] }, work_summary: workSummary };
}

function optionsFor(cwd: string, sessionId: string): BridgeOptions {
  return { cwd, sessionId };
}

function json(value: unknown): Record<string, any> {
  return value as Record<string, any>;
}

function promptFilesFromFeedback(feedback: string, project: string): string[] {
  return [...feedback.matchAll(/prompt_file: (.+)/g)].map((match) => {
    const file = match[1].trim();
    return isAbsolute(file) ? file : join(project, file);
  });
}

function reviewIdsFromFeedback(feedback: string): string[] {
  return [...feedback.matchAll(/review_id: ([^\n]+)/g)].map((match) => match[1].trim());
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
