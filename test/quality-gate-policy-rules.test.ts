import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishedStep, getReviewInstructions, markReviewAsPassed, startWorkflow, type BridgeOptions } from "../src/bridge.js";

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

describe("native quality gates from project review policies", () => {
  // Covers PI-REQ-001.13.1, PI-REQ-002.5.7, PI-REQ-002.5.8, PI-REQ-002.5.10, PI-REQ-002.12.5, and PI-REQ-003.3.1 through PI-REQ-003.3.4 by applying matching .deepreview rules to workflow output files and keeping the workflow on needs_work.
  it("returns needs_work and writes a prompt for matching .deepreview rules on output files", async () => {
    const project = await makeProject();
    await writeArtifactJob(project);
    await writeFile(join(project, ".deepreview"), deepreviewYaml());
    await writeFile(join(project, "artifact.txt"), "artifact body");
    const options = optionsFor(project, "deepreview-quality-session");

    await startWorkflow({ goal: "artifact", job_name: "artifact_job", workflow_name: "full" }, options);
    const result = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options));
    const promptFiles = promptFilesFromFeedback(result.feedback as string, project);
    const content = await readFile(promptFiles[0], "utf8");

    expect(result.status).toBe("needs_work");
    expect(promptFiles).toHaveLength(1);
    expect(content).toContain("# Review: artifact_policy — artifact.txt");
    expect(content).toContain("Review artifact output from .deepreview.");
    expect(content).toContain("workflow quality gate");
    expect(content).not.toContain("mcp__");
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.8, PI-REQ-002.5.10, PI-REQ-003.3.1, and PI-REQ-003.10.1 through PI-REQ-003.10.3 by applying DeepSchema-generated synthetic review rules to workflow output files.
  it("returns needs_work for DeepSchema-generated quality-gate review rules", async () => {
    const project = await makeProject();
    await writeArtifactJob(project);
    await mkdir(join(project, ".deepwork", "schemas", "artifact_schema"), { recursive: true });
    await writeFile(join(project, ".deepwork", "schemas", "artifact_schema", "deepschema.yml"), deepSchemaYaml());
    await writeFile(join(project, "artifact.txt"), "artifact body");
    const options = optionsFor(project, "deepschema-quality-session");

    await startWorkflow({ goal: "artifact", job_name: "artifact_job", workflow_name: "full" }, options);
    const result = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options));
    const content = await readFile(promptFilesFromFeedback(result.feedback as string, project)[0], "utf8");

    expect(result.status).toBe("needs_work");
    expect(content).toContain("# Review: artifact_schema DeepSchema Compliance — artifact.txt");
    expect(content).toContain("artifact.txt is an instance of artifact_schema.");
    expect(content).toContain("- **must_be_clear**: Artifact text MUST be clear.");
  });

  // Covers PI-REQ-002.5.11, PI-REQ-002.5.12, PI-REQ-002.9.13, and PI-REQ-003.3.4 by suppressing matching policy quality gates after native pass markers are written.
  it("advances to workflow_complete after matching quality-gate review IDs are marked passed", async () => {
    const project = await makeProject();
    await writeArtifactJob(project);
    await writeFile(join(project, ".deepreview"), deepreviewYaml());
    await writeFile(join(project, "artifact.txt"), "artifact body");
    const options = optionsFor(project, "passed-deepreview-quality-session");

    await startWorkflow({ goal: "artifact", job_name: "artifact_job", workflow_name: "full" }, options);
    const needsWork = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options));
    const reviewIds = reviewIdsFromFeedback(needsWork.feedback as string);
    for (const review_id of reviewIds) await markReviewAsPassed({ review_id }, options);

    const complete = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options));

    expect(reviewIds).toHaveLength(1);
    expect(complete.status).toBe("workflow_complete");
  });

  // Covers PI-REQ-003.1.9, PI-REQ-003.1.10, PI-REQ-003.7.1 through PI-REQ-003.7.5, and PI-REQ-003.9.5 by preserving review context sections in policy quality-gate prompt files.
  it("renders unchanged matching files, all changed filenames, and precomputed context in quality-gate prompts", async () => {
    const project = await makeProject();
    await writeArtifactJob(project);
    await writeFile(join(project, "artifact.txt"), "artifact body");
    await writeFile(join(project, "sibling.txt"), "sibling body");
    await mkdir(join(project, "scripts"), { recursive: true });
    await writeFile(join(project, "scripts", "context.sh"), "#!/bin/sh\nprintf 'quality context ok\\n'\n");
    await chmod(join(project, "scripts", "context.sh"), 0o755);
    await writeFile(join(project, ".deepreview"), `artifact_context_policy:
  description: Review artifact outputs with context.
  match:
    include:
      - "*.txt"
  review:
    strategy: matches_together
    additional_context:
      unchanged_matching_files: true
      all_changed_filenames: true
    precomputed_info_for_reviewer_bash_command: scripts/context.sh
    instructions: |
      Review artifact output with all context sections.
`);
    const options = optionsFor(project, "context-quality-session");

    await startWorkflow({ goal: "artifact", job_name: "artifact_job", workflow_name: "full" }, options);
    const result = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options));
    const content = await readFile(promptFilesFromFeedback(result.feedback as string, project)[0], "utf8");

    expect(result.status).toBe("needs_work");
    expect(content).toContain("## Unchanged Matching Files");
    expect(content).toContain("- sibling.txt");
    expect(content).toContain("## All Changed Files");
    expect(content).toContain("- artifact.txt");
    expect(content).toContain("## Precomputed Context");
    expect(content).toContain("quality context ok");
    expect(content).not.toContain("mcp__");
  });

  // Covers PI-REQ-002.9.13, PI-REQ-003.3.4, and PI-REQ-003.10.2 by keeping native policy quality-gate review IDs compatible with native review instruction IDs and pass markers.
  it("uses the same deterministic review IDs for policy quality gates and native review instructions", async () => {
    const project = await makeProject();
    await writeArtifactJob(project);
    await writeFile(join(project, ".deepreview"), deepreviewYaml());
    await writeFile(join(project, "artifact.txt"), "artifact body");
    const options = optionsFor(project, "deterministic-id-quality-session");

    const reviewOutput = await getReviewInstructions({ files: ["artifact.txt"] }, options);
    const instructionReviewIds = reviewIdsFromFeedback(reviewOutput);
    await startWorkflow({ goal: "artifact", job_name: "artifact_job", workflow_name: "full" }, options);
    const needsWork = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options));
    const qualityReviewIds = reviewIdsFromFeedback(needsWork.feedback as string);

    expect(instructionReviewIds).toEqual(qualityReviewIds);

    await markReviewAsPassed({ review_id: instructionReviewIds[0] }, options);
    const complete = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact again" }, options));
    expect(complete.status).toBe("workflow_complete");
  });

  // Covers PI-REQ-002.5.7, PI-REQ-002.5.13, and PI-REQ-002.12.6 by advancing normally when no .deepreview or DeepSchema quality-gate rule matches the output file.
  it("advances to next_step when output files do not match review or DeepSchema quality policies", async () => {
    const project = await makeProject();
    await writeTwoStepJob(project);
    await writeFile(join(project, ".deepreview"), deepreviewYaml("docs/**/*.md"));
    await writeFile(join(project, "artifact.txt"), "artifact body");
    const options = optionsFor(project, "no-match-quality-session");

    await startWorkflow({ goal: "artifact", job_name: "two_step_job", workflow_name: "full" }, options);
    const result = json(await finishedStep({ outputs: { artifact: "artifact.txt" }, work_summary: "wrote artifact" }, options));

    expect(result.status).toBe("next_step");
    expect(result.begin_step.step_id).toBe("second_step");
    expect(result).not.toHaveProperty("issue_detected");
  });
});

async function makeProject(): Promise<string> {
  const project = await makeTempDir("quality-policy");
  await mkdir(join(project, ".deepwork", "jobs"), { recursive: true });
  return project;
}

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `deepwork-pi-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeArtifactJob(project: string): Promise<void> {
  await writeJob(project, "artifact_job", `name: artifact_job
summary: Artifact job
step_arguments:
  - name: artifact
    description: Artifact file
    type: file_path
workflows:
  full:
    summary: Full workflow
    steps:
      - name: only_step
        instructions: Produce artifact.
        outputs:
          artifact: {}
`);
}

async function writeTwoStepJob(project: string): Promise<void> {
  await writeJob(project, "two_step_job", `name: two_step_job
summary: Two step job
step_arguments:
  - name: artifact
    description: Artifact file
    type: file_path
  - name: done
    description: Done text
    type: string
workflows:
  full:
    summary: Full workflow
    steps:
      - name: first_step
        instructions: Produce artifact.
        outputs:
          artifact: {}
      - name: second_step
        instructions: Finish.
        inputs:
          artifact: {}
        outputs:
          done: {}
`);
}

async function writeJob(project: string, name: string, yaml: string): Promise<void> {
  const dir = join(project, ".deepwork", "jobs", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "job.yml"), yaml);
}

function deepreviewYaml(include = "*.txt"): string {
  return `artifact_policy:
  description: Review artifact outputs.
  match:
    include:
      - "${include}"
  review:
    strategy: individual
    instructions: |
      Review artifact output from .deepreview.
`;
}

function deepSchemaYaml(): string {
  return `summary: Artifact schema
matchers:
  - "*.txt"
requirements:
  must_be_clear: "Artifact text MUST be clear."
`;
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
