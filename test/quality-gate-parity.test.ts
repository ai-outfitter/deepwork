import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishedStep, markReviewAsPassed, startWorkflow, type BridgeOptions } from "../src/bridge.js";

const tempDirs: string[] = [];
let previousStandardJobsDir: string | undefined;

beforeEach(async () => {
  previousStandardJobsDir = process.env.DEEPWORK_STANDARD_JOBS_DIR;
  process.env.DEEPWORK_STANDARD_JOBS_DIR = await makeTempDir("empty-standard");
});

afterEach(async () => {
  restoreEnv("DEEPWORK_STANDARD_JOBS_DIR", previousStandardJobsDir);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("native quality-gate parity coverage", () => {
  // Covers PI-REQ-002.5.8, PI-REQ-002.5.10, PI-REQ-003.1.2, PI-REQ-003.1.3, and PI-REQ-003.9.3 by verifying output-ref reviews run before step_argument reviews with deterministic names and native mark-pass instructions.
  it("generates output-ref reviews before step_argument reviews with distinct rule names", async () => {
    const project = await makeProject();
    await writeJob(project, "ordered_review_job", orderedReviewJobYaml());
    const options = optionsFor(project, "ordered-review-session");

    await startWorkflow({ goal: "ordered", job_name: "ordered_review_job", workflow_name: "full" }, options);
    const result = await finishedStep({ outputs: { reviewed_text: "draft" }, work_summary: "drafted" }, options);
    const feedback = json(result).feedback as string;
    const promptFiles = promptFilesFromFeedback(feedback);
    const contents = await Promise.all(promptFiles.map((path) => readFile(path, "utf8")));

    expect(json(result).status).toBe("needs_work");
    expect(contents[0]).toContain("# Review: step_only_step_output_reviewed_text — inline content");
    expect(contents[0]).toContain("Step-specific review comes first.");
    expect(contents[1]).toContain("# Review: step_only_step_output_reviewed_text_arg — inline content");
    expect(contents[1]).toContain("Argument-level review comes second.");
    expect(feedback.indexOf("step_only_step_output_reviewed_text_")).toBeLessThan(feedback.indexOf("step_only_step_output_reviewed_text_arg_"));
  });

  // Covers PI-REQ-003.1.4 through PI-REQ-003.1.8, PI-REQ-003.2.1, PI-REQ-003.2.2, and PI-REQ-003.2.6 by checking file_path output instruction content.
  it("renders file_path output review instructions with project root and relative files to review", async () => {
    const project = await makeProject();
    await writeJob(project, "file_review_job", fileReviewJobYaml());
    await writeFile(join(project, "artifact.txt"), "artifact body");
    const options = optionsFor(project, "file-review-session");

    await startWorkflow({ goal: "file review", job_name: "file_review_job", workflow_name: "full" }, options);
    const result = await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options);
    const content = await readFile(promptFilesFromFeedback(json(result).feedback as string)[0], "utf8");

    expect(content).toContain("## Project Root");
    expect(content).toContain(project);
    expect(content).toContain("Read files from this project root using Pi file-reading tools");
    expect(content).toContain("## Files to Review");
    expect(content).toContain("- artifact.txt");
    expect(content).not.toContain("mcp__");
  });

  // Covers PI-REQ-002.5.8, PI-REQ-002.5.10, and PI-REQ-003.9.1 through PI-REQ-003.9.5 by generating process-requirement quality tasks from work_summary.
  it("generates process requirement quality tasks using work_summary and step outputs", async () => {
    const project = await makeProject();
    await writeJob(project, "process_job", processRequirementJobYaml());
    const options = optionsFor(project, "process-review-session");

    await startWorkflow({ goal: "process", job_name: "process_job", workflow_name: "full" }, options);
    const result = await finishedStep({ outputs: { report: "report text" }, work_summary: "I wrote the report but did not run tests." }, options);
    const content = await readFile(promptFilesFromFeedback(json(result).feedback as string)[0], "utf8");

    expect(json(result).status).toBe("needs_work");
    expect(content).toContain("# Review: step_only_step_process_quality — inline content");
    expect(content).toContain("## Process Requirements Review");
    expect(content).toContain("- **testing**: Work summary MUST mention tests run.");
    expect(content).toContain("I wrote the report but did not run tests.");
    expect(content).toContain("deepwork_mark_review_as_passed");
  });

  // Covers PI-REQ-002.5.8, PI-REQ-002.5.11, PI-REQ-002.9.13, and PI-REQ-003.5.1 by preserving passed review markers and suppressing already-passed native quality tasks.
  it("suppresses quality review tasks when their review IDs have passed markers", async () => {
    const project = await makeProject();
    await writeJob(project, "ordered_review_job", orderedReviewJobYaml());
    const options = optionsFor(project, "pass-cache-session");

    await startWorkflow({ goal: "pass cache", job_name: "ordered_review_job", workflow_name: "full" }, options);
    const needsWork = await finishedStep({ outputs: { reviewed_text: "draft" }, work_summary: "drafted" }, options);
    const reviewIds = reviewIdsFromFeedback(json(needsWork).feedback as string);
    for (const review_id of reviewIds) await markReviewAsPassed({ review_id }, options);

    const complete = await finishedStep({ outputs: { reviewed_text: "draft" }, work_summary: "drafted" }, options);

    expect(reviewIds.length).toBe(2);
    expect(json(complete).status).toBe("workflow_complete");
  });

  // Covers PI-REQ-002.5.8, PI-REQ-002.5.10, PI-REQ-002.9.13, and PI-REQ-003.3.4 by documenting native built-in quality review ID semantics: IDs are deterministic for unchanged outputs and change when inline output content changes.
  it("invalidates built-in quality pass markers when string output content changes", async () => {
    const project = await makeProject();
    await writeJob(project, "ordered_review_job", orderedReviewJobYaml());
    const options = optionsFor(project, "built-in-pass-invalidation-session");

    await startWorkflow({ goal: "built-in invalidation", job_name: "ordered_review_job", workflow_name: "full" }, options);
    const firstNeedsWork = await finishedStep({ outputs: { reviewed_text: "draft v1" }, work_summary: "drafted v1" }, options);
    const firstReviewIds = reviewIdsFromFeedback(json(firstNeedsWork).feedback as string);
    for (const review_id of firstReviewIds) await markReviewAsPassed({ review_id }, options);

    const secondNeedsWork = await finishedStep({ outputs: { reviewed_text: "draft v2" }, work_summary: "drafted v2" }, options);
    const secondReviewIds = reviewIdsFromFeedback(json(secondNeedsWork).feedback as string);

    expect(json(secondNeedsWork).status).toBe("needs_work");
    expect(firstReviewIds).toHaveLength(2);
    expect(secondReviewIds).toHaveLength(2);
    expect(secondReviewIds).not.toEqual(firstReviewIds);
  });
});

async function makeProject(): Promise<string> {
  const project = await makeTempDir("quality-parity");
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

function promptFilesFromFeedback(feedback: string): string[] {
  return [...feedback.matchAll(/prompt_file: (.+)/g)].map((match) => match[1].trim());
}

function reviewIdsFromFeedback(feedback: string): string[] {
  return [...feedback.matchAll(/review_id: ([^\n]+)/g)].map((match) => match[1].trim());
}

function orderedReviewJobYaml(): string {
  return `name: ordered_review_job
summary: Ordered reviews
step_arguments:
  - name: reviewed_text
    description: Reviewed text
    type: string
    review:
      strategy: individual
      instructions: Argument-level review comes second.
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce reviewed text.
        outputs:
          reviewed_text:
            review:
              strategy: individual
              instructions: Step-specific review comes first.
`;
}

function fileReviewJobYaml(): string {
  return `name: file_review_job
summary: File reviews
step_arguments:
  - name: artifact
    description: Artifact path
    type: file_path
    review:
      strategy: individual
      instructions: Review the artifact file.
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

function processRequirementJobYaml(): string {
  return `name: process_job
summary: Process quality
step_arguments:
  - name: report
    description: Report text
    type: string
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce report.
        outputs:
          report: {}
        process_requirements:
          testing: Work summary MUST mention tests run.
`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
