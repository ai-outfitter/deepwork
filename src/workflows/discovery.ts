import AjvModule, { type ValidateFunction } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type {
  GetWorkflowsResponse,
  Issue,
  JobDefinition,
  JobInfo,
  JobLoadError,
  ReviewBlock,
  StepInputRef,
  StepOutputRef,
  Workflow,
  WorkflowStep,
} from "../types/workflows.js";

const ENV_ADDITIONAL_JOBS_FOLDERS = "DEEPWORK_ADDITIONAL_JOBS_FOLDERS";
const ENV_STANDARD_JOBS_DIR = "DEEPWORK_STANDARD_JOBS_DIR";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(moduleDir, "job.schema.json");
let compiledSchema: ValidateFunction | null = null;

export class JobParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobParseError";
  }
}

export async function getWorkflowsNative(projectRoot: string): Promise<GetWorkflowsResponse> {
  const root = resolve(projectRoot);
  await ensureSchemaAvailable(root);

  const { jobs, errors } = await loadAllJobs(root);
  const issues = errorsToIssues(errors);
  const response: GetWorkflowsResponse = {
    jobs: jobs.map(jobToInfo),
    errors: issues.map((issue) => ({
      job_name: issue.job_name,
      job_dir: issue.job_dir,
      error: `${issue.message}\n${issue.suggestion}`,
    })),
  };

  if (issues.length > 0) {
    response.issue_detected = formatIssueWarning(issues);
  }

  return response;
}

export async function getJobFolders(projectRoot: string): Promise<string[]> {
  const folders = [join(projectRoot, ".deepwork", "jobs")];
  const standard = standardJobsDir();
  if (standard) folders.push(standard);

  const extra = process.env[ENV_ADDITIONAL_JOBS_FOLDERS] ?? "";
  for (const entry of extra.split(":")) {
    const trimmed = entry.trim();
    if (trimmed) folders.push(trimmed);
  }

  return folders;
}

export async function loadAllJobs(projectRoot: string): Promise<{ jobs: JobDefinition[]; errors: JobLoadError[] }> {
  const jobs: JobDefinition[] = [];
  const errors: JobLoadError[] = [];
  const seenNames = new Set<string>();

  for (const folder of await getJobFolders(projectRoot)) {
    if (!existsSync(folder)) continue;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const jobDir = join(folder, entry.name);
      if (!existsSync(join(jobDir, "job.yml"))) continue;
      if (seenNames.has(entry.name)) continue;

      try {
        const job = await parseJobDefinition(jobDir);
        jobs.push(job);
        seenNames.add(entry.name);
      } catch (error) {
        errors.push({
          job_name: entry.name,
          job_dir: jobDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { jobs, errors };
}

export async function parseJobDefinition(jobDir: string): Promise<JobDefinition> {
  const resolvedJobDir = resolve(jobDir);
  if (!existsSync(resolvedJobDir)) throw new JobParseError(`Job directory does not exist: ${resolvedJobDir}`);
  const jobFile = join(resolvedJobDir, "job.yml");
  if (!existsSync(jobFile)) throw new JobParseError(`job.yml not found in ${resolvedJobDir}`);

  let jobData: unknown;
  try {
    const source = await readFile(jobFile, "utf8");
    jobData = parseYaml(source);
  } catch (error) {
    const message = error instanceof YAMLParseError || error instanceof Error ? error.message : String(error);
    throw new JobParseError(`Failed to load job.yml: ${message}`);
  }

  if (!jobData) throw new JobParseError("job.yml is empty");
  validateJobData(jobData);

  const raw = jobData as Record<string, unknown>;
  const job: JobDefinition = {
    name: String(raw.name),
    summary: String(raw.summary),
    step_arguments: ((raw.step_arguments as unknown[]) ?? []).map((arg) => parseStepArgument(arg)),
    workflows: Object.fromEntries(
      Object.entries((raw.workflows as Record<string, unknown>) ?? {}).map(([name, workflow]) => [
        name,
        parseWorkflow(name, workflow),
      ]),
    ),
    job_dir: resolvedJobDir,
  };

  validateUniqueStepNames(job);
  validateArgumentRefs(job);
  validateSubWorkflows(job);
  validateStepExclusivity(job);
  return job;
}

function parseStepArgument(value: unknown) {
  const raw = value as Record<string, unknown>;
  return {
    name: String(raw.name),
    description: String(raw.description),
    type: raw.type as "string" | "file_path",
    ...(raw.review ? { review: parseReviewBlock(raw.review) } : {}),
    ...(raw.json_schema ? { json_schema: raw.json_schema as Record<string, unknown> } : {}),
  };
}

function parseWorkflow(name: string, value: unknown): Workflow {
  const raw = value as Record<string, unknown>;
  return {
    name,
    summary: String(raw.summary),
    steps: ((raw.steps as unknown[]) ?? []).map(parseWorkflowStep),
    ...(raw.agent ? { agent: String(raw.agent) } : {}),
    ...(raw.common_job_info_provided_to_all_steps_at_runtime
      ? { common_job_info: String(raw.common_job_info_provided_to_all_steps_at_runtime) }
      : {}),
    ...(raw.post_workflow_instructions ? { post_workflow_instructions: String(raw.post_workflow_instructions) } : {}),
  };
}

function parseWorkflowStep(value: unknown): WorkflowStep {
  const raw = value as Record<string, unknown>;
  return {
    name: String(raw.name),
    ...(raw.instructions !== undefined ? { instructions: String(raw.instructions) } : {}),
    ...(raw.sub_workflow ? { sub_workflow: raw.sub_workflow as { workflow_name: string; workflow_job?: string } } : {}),
    inputs: parseInputRefs(raw.inputs),
    outputs: parseOutputRefs(raw.outputs),
    process_requirements: (raw.process_requirements as Record<string, string>) ?? {},
  };
}

function parseInputRefs(value: unknown): Record<string, StepInputRef> {
  return Object.fromEntries(
    Object.entries((value as Record<string, Record<string, unknown>>) ?? {}).map(([name, ref]) => [
      name,
      { argument_name: name, required: ref.required !== undefined ? Boolean(ref.required) : true },
    ]),
  );
}

function parseOutputRefs(value: unknown): Record<string, StepOutputRef> {
  return Object.fromEntries(
    Object.entries((value as Record<string, Record<string, unknown>>) ?? {}).map(([name, ref]) => [
      name,
      {
        argument_name: name,
        required: ref.required !== undefined ? Boolean(ref.required) : true,
        ...(ref.review ? { review: parseReviewBlock(ref.review) } : {}),
      },
    ]),
  );
}

function parseReviewBlock(value: unknown): ReviewBlock {
  const raw = value as Record<string, unknown>;
  return {
    strategy: raw.strategy as "individual" | "matches_together",
    instructions: String(raw.instructions),
    ...(raw.agent ? { agent: raw.agent as Record<string, string> } : {}),
    ...(raw.additional_context ? { additional_context: raw.additional_context as Record<string, boolean> } : {}),
    ...(raw.review_depth ? { review_depth: raw.review_depth as "lightweight" } : {}),
  };
}

function validateJobData(jobData: unknown): void {
  if (!compiledSchema) {
    const schema = JSON.parse(readFileSyncUtf8(schemaPath));
    const AjvCtor = AjvModule as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: unknown): ValidateFunction };
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    compiledSchema = ajv.compile(schema);
  }

  const validate = compiledSchema;
  if (!validate(jobData)) {
    const message = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") || "unknown validation error";
    throw new JobParseError(`Job definition validation failed: ${message}`);
  }
}

function validateUniqueStepNames(job: JobDefinition): void {
  for (const [workflowName, workflow] of Object.entries(job.workflows)) {
    const seen = new Set<string>();
    for (const step of workflow.steps) {
      if (seen.has(step.name)) throw new JobParseError(`Workflow '${workflowName}' has duplicate step name '${step.name}'`);
      seen.add(step.name);
    }
  }
}

function validateArgumentRefs(job: JobDefinition): void {
  const argNames = new Set(job.step_arguments.map((arg) => arg.name));
  for (const [workflowName, workflow] of Object.entries(job.workflows)) {
    for (const step of workflow.steps) {
      for (const inputName of Object.keys(step.inputs)) {
        if (!argNames.has(inputName)) throw new JobParseError(`Workflow '${workflowName}' step '${step.name}' references non-existent step_argument '${inputName}' in inputs`);
      }
      for (const outputName of Object.keys(step.outputs)) {
        if (!argNames.has(outputName)) throw new JobParseError(`Workflow '${workflowName}' step '${step.name}' references non-existent step_argument '${outputName}' in outputs`);
      }
    }
  }
}

function validateSubWorkflows(job: JobDefinition): void {
  for (const [workflowName, workflow] of Object.entries(job.workflows)) {
    for (const step of workflow.steps) {
      if (step.sub_workflow && !step.sub_workflow.workflow_job && !job.workflows[step.sub_workflow.workflow_name]) {
        throw new JobParseError(`Workflow '${workflowName}' step '${step.name}' references non-existent workflow '${step.sub_workflow.workflow_name}'`);
      }
    }
  }
}

function validateStepExclusivity(job: JobDefinition): void {
  for (const [workflowName, workflow] of Object.entries(job.workflows)) {
    for (const step of workflow.steps) {
      const hasInstructions = step.instructions !== undefined;
      const hasSubWorkflow = step.sub_workflow !== undefined;
      if (hasInstructions && hasSubWorkflow) throw new JobParseError(`Workflow '${workflowName}' step '${step.name}' has both 'instructions' and 'sub_workflow' — must have exactly one`);
      if (!hasInstructions && !hasSubWorkflow) throw new JobParseError(`Workflow '${workflowName}' step '${step.name}' has neither 'instructions' nor 'sub_workflow' — must have exactly one`);
    }
  }
}

function jobToInfo(job: JobDefinition): JobInfo {
  return {
    name: job.name,
    summary: job.summary,
    workflows: Object.entries(job.workflows).map(([workflowName, workflow]) => ({
      name: workflowName,
      summary: workflow.summary,
      how_to_invoke: workflow.agent
        ? `Invoke as an Agent using subagent_type="${workflow.agent}" with a prompt giving full context needed and instructions to call \`deepwork_start_workflow\` (job_name="${job.name}", workflow_name="${workflowName}"). If you do not have Agent as an available tool, invoke the workflow directly.`
        : `Call \`deepwork_start_workflow\` with job_name="${job.name}" and workflow_name="${workflowName}", then follow the step instructions it returns.`,
    })),
  };
}

function errorsToIssues(errors: JobLoadError[]): Issue[] {
  return errors.map((error) => ({
    severity: "error",
    job_name: error.job_name,
    job_dir: error.job_dir,
    message: error.error,
    suggestion: `The invalid file is ${error.job_dir}/job.yml. If you edited that file this session, fix it directly. If you did not edit it, the project may need \`/deepwork repair\` to migrate legacy formats.`,
  }));
}

function formatIssueWarning(issues: Issue[]): string {
  return [
    "",
    "",
    "---",
    "**IMPORTANT: ISSUE DETECTED.** Suggest repairing this immediately to the user.",
    "",
    issues.map((issue) => `- **${issue.job_name}**: ${issue.message}\n  ${issue.suggestion}`).join("\n"),
  ].join("\n");
}

async function ensureSchemaAvailable(projectRoot: string): Promise<void> {
  try {
    const targetDir = join(projectRoot, ".deepwork");
    await mkdir(targetDir, { recursive: true });
    await copyFile(schemaPath, join(targetDir, "job.schema.json"));
  } catch {
    // Match DeepWork's best-effort schema copy behavior.
  }
}

function standardJobsDir(): string | null {
  const configured = process.env[ENV_STANDARD_JOBS_DIR];
  if (configured) return configured;

  const candidates = [
    resolve(moduleDir, "..", "..", "standard_jobs"),
    resolve(moduleDir, "..", "..", "..", "deep-work", "src", "deepwork", "standard_jobs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readFileSyncUtf8(path: string): string {
  // Keep schema loading sync so AJV compilation remains lazy and simple.
  return readFileSync(path, "utf8");
}
