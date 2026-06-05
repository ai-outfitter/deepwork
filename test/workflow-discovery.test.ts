import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJobFolders, getWorkflowsNative, loadAllJobs, parseJobDefinition } from "../src/workflows/discovery.js";

const tempDirs: string[] = [];
let previousStandardJobsDir: string | undefined;
let previousAdditionalJobsFolders: string | undefined;

beforeEach(async () => {
  previousStandardJobsDir = process.env.DEEPWORK_STANDARD_JOBS_DIR;
  previousAdditionalJobsFolders = process.env.DEEPWORK_ADDITIONAL_JOBS_FOLDERS;
  process.env.DEEPWORK_STANDARD_JOBS_DIR = await makeTempDir("empty-standard");
  delete process.env.DEEPWORK_ADDITIONAL_JOBS_FOLDERS;
});

afterEach(async () => {
  restoreEnv("DEEPWORK_STANDARD_JOBS_DIR", previousStandardJobsDir);
  restoreEnv("DEEPWORK_ADDITIONAL_JOBS_FOLDERS", previousAdditionalJobsFolders);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("workflow discovery", () => {
  // Covers PI-REQ-002.1.7.
  it("copies job.schema.json into the project .deepwork directory", async () => {
    const project = await makeProject();
    await writeProjectJob(project, "alpha", validJobYaml({ jobName: "alpha" }));

    await getWorkflowsNative(project);

    const copiedSchema = join(project, ".deepwork", "job.schema.json");
    expect(existsSync(copiedSchema)).toBe(true);
    expect(JSON.parse(await readFile(copiedSchema, "utf8"))).toHaveProperty("$schema");
  });

  // Covers PI-REQ-001.13.1 and PI-REQ-002.2.8 for packaged standard job discovery.
  it("loads bundled standard jobs when no standard jobs override is configured", async () => {
    const project = await makeProject();
    delete process.env.DEEPWORK_STANDARD_JOBS_DIR;

    const result = await getWorkflowsNative(project);

    const jobNames = result.jobs.map((job) => job.name);
    expect(jobNames).toContain("deepwork_jobs");
    expect(jobNames).toContain("deepwork_reviews");
    expect(jobNames).toContain("deepplan");
    expect(result.jobs.find((job) => job.name === "deepwork_jobs")?.workflows.map((workflow) => workflow.name)).toContain("new_job");
    expect(result.errors).toEqual([]);
  });

  // Covers PI-REQ-001.13.1 and PI-REQ-002.2.8 for job discovery ordering compatibility.
  it("loads project jobs before standard jobs and skips duplicate directory names", async () => {
    const project = await makeProject();
    const standardRoot = await makeTempDir("standard-jobs");
    process.env.DEEPWORK_STANDARD_JOBS_DIR = standardRoot;

    await writeProjectJob(project, "dupe", validJobYaml({ jobName: "project_job", summary: "Project wins" }));
    await writeJob(standardRoot, "dupe", validJobYaml({ jobName: "standard_job", summary: "Standard loses" }));
    await writeJob(standardRoot, "standard_only", validJobYaml({ jobName: "standard_only", summary: "Standard only" }));

    const { jobs, errors } = await loadAllJobs(project);

    expect(errors).toEqual([]);
    expect(jobs.map((job) => job.name)).toEqual(["project_job", "standard_only"]);
    expect(jobs[0].summary).toBe("Project wins");
  });

  // Covers PI-REQ-001.13.1 and PI-REQ-002.10.2-style environment-configured source discovery for workflow jobs.
  it("appends colon-delimited additional job folders after project and standard folders", async () => {
    const project = await makeProject();
    const extraOne = await makeTempDir("extra-one");
    const extraTwo = await makeTempDir("extra-two");
    process.env.DEEPWORK_ADDITIONAL_JOBS_FOLDERS = `${extraOne}:  :${extraTwo}`;

    await writeJob(extraOne, "extra_one", validJobYaml({ jobName: "extra_one" }));
    await writeJob(extraTwo, "extra_two", validJobYaml({ jobName: "extra_two" }));

    const folders = await getJobFolders(project);
    const { jobs } = await loadAllJobs(project);

    expect(folders.slice(-2)).toEqual([extraOne, extraTwo]);
    expect(jobs.map((job) => job.name)).toEqual(["extra_one", "extra_two"]);
  });

  // Covers PI-REQ-002.12.2 and PI-REQ-002.12.3 for invalid-job detection during discovery.
  it("does not let an invalid project duplicate hide a valid standard job with the same directory name", async () => {
    const project = await makeProject();
    const standardRoot = await makeTempDir("standard-jobs");
    process.env.DEEPWORK_STANDARD_JOBS_DIR = standardRoot;

    await writeProjectJob(project, "same_dir", "name: INVALID-NAME\n");
    await writeJob(standardRoot, "same_dir", validJobYaml({ jobName: "standard_same_dir" }));

    const { jobs, errors } = await loadAllJobs(project);

    expect(errors).toHaveLength(1);
    expect(errors[0].job_name).toBe("same_dir");
    expect(jobs.map((job) => job.name)).toEqual(["standard_same_dir"]);
  });

  // Covers PI-REQ-002.3.6 and PI-REQ-002.13.4.
  it("formats agent workflow invocation without MCP tool names", async () => {
    const project = await makeProject();
    await writeProjectJob(project, "agent_job", validJobYaml({ jobName: "agent_job", agent: "reviewer" }));

    const result = await getWorkflowsNative(project);

    expect(result.jobs[0].workflows[0].how_to_invoke).toContain('subagent_type="reviewer"');
    expect(result.jobs[0].workflows[0].how_to_invoke).toContain("deepwork_start_workflow");
    expect(result.jobs[0].workflows[0].how_to_invoke).not.toContain("mcp__");
  });
});

describe("workflow parsing validations", () => {
  // Covers PI-REQ-001.13.1 and PI-REQ-002.2.8 for preserving DeepWork parser defaults and optional fields.
  it("parses defaults and optional fields used by runtime workflow steps", async () => {
    const project = await makeProject();
    const jobDir = await writeProjectJob(project, "rich", richJobYaml());

    const job = await parseJobDefinition(jobDir);

    expect(job.workflows.full.agent).toBe("planner");
    expect(job.workflows.full.common_job_info).toBe("Shared context");
    expect(job.workflows.full.post_workflow_instructions).toBe("Done");
    expect(job.workflows.full.steps[0].inputs.seed.required).toBe(true);
    expect(job.workflows.full.steps[0].outputs.report.required).toBe(false);
    expect(job.step_arguments[1].review?.strategy).toBe("individual");
    expect(job.step_arguments[1].json_schema).toEqual({ type: "object" });
  });

  // Covers PI-REQ-002.12.2 and PI-REQ-002.12.3 for schema and semantic parse failures.
  it.each([
    {
      name: "duplicate step names",
      yaml: validJobYaml({ extraStep: "      - name: do_work\n        instructions: Again\n" }),
      message: "duplicate step name 'do_work'",
    },
    {
      name: "unknown input argument refs",
      yaml: validJobYaml({ inputs: "missing: {}" }),
      message: "references non-existent step_argument 'missing' in inputs",
    },
    {
      name: "unknown output argument refs",
      yaml: validJobYaml({ outputs: "missing: {}" }),
      message: "references non-existent step_argument 'missing' in outputs",
    },
    {
      name: "missing same-job subworkflow refs",
      yaml: validJobYaml({ instructionsBlock: "sub_workflow:\n  workflow_name: absent" }),
      message: "references non-existent workflow 'absent'",
    },
    {
      name: "both instructions and subworkflow on a step",
      yaml: validJobYaml({ instructionsBlock: "instructions: Do it\nsub_workflow:\n  workflow_name: helper", helperWorkflow: true }),
      message: "has both 'instructions' and 'sub_workflow'",
    },
    {
      name: "neither instructions nor subworkflow on a step",
      yaml: validJobYaml({ instructionsBlock: "" }),
      message: "has neither 'instructions' nor 'sub_workflow'",
    },
  ])("rejects $name", async ({ yaml, message }) => {
    const project = await makeProject();
    const jobDir = await writeProjectJob(project, "invalid", yaml);

    await expect(parseJobDefinition(jobDir)).rejects.toThrow(message);
  });

  // Covers PI-REQ-001.13.1 by preserving DeepWork's runtime-only validation for cross-job subworkflow references.
  it("allows cross-job subworkflow references because they are validated at runtime", async () => {
    const project = await makeProject();
    const jobDir = await writeProjectJob(
      project,
      "cross_job",
      validJobYaml({ instructionsBlock: "sub_workflow:\n  workflow_job: other_job\n  workflow_name: other_workflow" }),
    );

    await expect(parseJobDefinition(jobDir)).resolves.toHaveProperty("name", "sample_job");
  });
});

async function makeProject(): Promise<string> {
  const project = await makeTempDir("project");
  await mkdir(join(project, ".deepwork", "jobs"), { recursive: true });
  return project;
}

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `deepwork-pi-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeProjectJob(project: string, dirName: string, yaml: string): Promise<string> {
  return writeJob(join(project, ".deepwork", "jobs"), dirName, yaml);
}

async function writeJob(root: string, dirName: string, yaml: string): Promise<string> {
  const jobDir = join(root, dirName);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "job.yml"), yaml);
  return jobDir;
}

function validJobYaml(options: {
  jobName?: string;
  summary?: string;
  agent?: string;
  inputs?: string;
  outputs?: string;
  instructionsBlock?: string;
  extraStep?: string;
  helperWorkflow?: boolean;
} = {}): string {
  const workflowAgent = options.agent ? `    agent: ${options.agent}\n` : "";
  const inputs = indent(options.inputs ?? "seed: {}", 10);
  const outputs = indent(options.outputs ?? "report: {}", 10);
  const instructionsBlock = indent(options.instructionsBlock ?? "instructions: Do the work", 8);
  const extraStep = options.extraStep ?? "";
  const helper = options.helperWorkflow
    ? `
  helper:
    summary: Helper workflow
    steps:
      - name: help
        instructions: Help
`
    : "";

  return `name: ${options.jobName ?? "sample_job"}
summary: ${options.summary ?? "Sample job"}
step_arguments:
  - name: seed
    description: Seed input
    type: string
  - name: report
    description: Report output
    type: file_path
workflows:
  full:
    summary: Full workflow
${workflowAgent}    steps:
      - name: do_work
${instructionsBlock}
        inputs:
${inputs}
        outputs:
${outputs}
${extraStep}${helper}`;
}

function richJobYaml(): string {
  return `name: rich_job
summary: Rich job
step_arguments:
  - name: seed
    description: Seed input
    type: string
  - name: report
    description: Report output
    type: file_path
    json_schema:
      type: object
    review:
      strategy: individual
      instructions: Check the report
      agent:
        reviewer: careful
      additional_context:
        all_changed_filenames: true
workflows:
  full:
    summary: Full workflow
    agent: planner
    common_job_info_provided_to_all_steps_at_runtime: Shared context
    post_workflow_instructions: Done
    steps:
      - name: do_work
        instructions: Do the work
        inputs:
          seed: {}
        outputs:
          report:
            required: false
            review:
              strategy: matches_together
              instructions: Check together
        process_requirements:
          testing: Work summary MUST mention tests.
`;
}

function indent(value: string, spaces: number): string {
  if (!value) return "";
  return value
    .split("\n")
    .map((line) => `${" ".repeat(spaces)}${line}`)
    .join("\n");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
