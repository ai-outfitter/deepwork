import AjvModule, { type ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { JsonValue } from "../bridge.js";
import { generateDeepSchemaReviewRules } from "../deepschema/reviews.js";
import { loadAllReviewRules } from "../reviews/config.js";
import { formatReviewTasksForPi, writeInstructionFiles, type WrittenReviewTask } from "../reviews/instructions.js";
import { findUnchangedMatchingFiles, matchFilesToRules } from "../reviews/matching.js";
import type { ReviewTaskNative } from "../types/reviews.js";
import type { JobDefinition, ReviewBlock, Workflow, WorkflowStep } from "../types/workflows.js";

// Hung-reviewer retry policy constants.
// A reviewer is "hung" when it completes with 0 tool uses — a signal of API overload
// or a dropped connection. Hung reviewers must be retried, not silently passed.
// REVIEWER_FAST_FAIL_SECONDS: elapsed time below this threshold means the reviewer
// never received an API response at all — retry immediately without backoff.
export const REVIEWER_MAX_RETRIES = 1;
export const REVIEWER_FAST_FAIL_SECONDS = 30;

export type QualityGateInput = {
  step: WorkflowStep;
  job: JobDefinition;
  workflow: Workflow;
  outputs: Record<string, JsonValue>;
  inputValues: Record<string, JsonValue>;
  workSummary?: string | null;
  projectRoot: string;
};

type QualityReviewTask = {
  reviewId: string;
  ruleName: string;
  description: string;
  instructions: string;
  filesToReview: string[];
  inlineContent?: string;
  sourceLocation: string;
};

export async function runQualityGateNative(input: QualityGateInput): Promise<string | null> {
  const schemaErrors = await validateJsonSchemas(input.outputs, input.step, input.job, input.projectRoot);
  if (schemaErrors.length > 0) {
    const errorText = schemaErrors.map((error) => `- ${error}`).join("\n");
    return `JSON schema validation failed:\n\n${errorText}\n\nFix these issues and call finished_step again.`;
  }

  const builtInTasks = buildQualityReviewTasks(input);
  const outputFileTasks = await buildOutputFilePolicyTasks(input);
  if (builtInTasks.length === 0 && outputFileTasks.length === 0) return null;

  const policyTaskFiles = outputFileTasks.length > 0 ? await writeInstructionFiles(outputFileTasks, input.projectRoot) : [];
  const taskFiles = await writeQualityInstructionFiles(builtInTasks, input.projectRoot);
  if (taskFiles.length === 0 && policyTaskFiles.length === 0) return null;

  return buildReviewGuidance(taskFiles, policyTaskFiles, input.projectRoot);
}

async function validateJsonSchemas(
  outputs: Record<string, JsonValue>,
  step: WorkflowStep,
  job: JobDefinition,
  projectRoot: string,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [outputName, value] of Object.entries(outputs)) {
    if (!step.outputs[outputName]) continue;
    const arg = job.step_arguments.find((item) => item.name === outputName);
    if (!arg?.json_schema || arg.type !== "file_path") continue;

    const paths = Array.isArray(value) ? value : [value];
    for (const path of paths) {
      if (typeof path !== "string") continue;
      const fullPath = isAbsolute(path) ? path : join(projectRoot, path);
      if (!existsSync(fullPath)) continue;

      let parsed: unknown;
      try {
        parsed = parseYaml(await readFile(fullPath, "utf8"));
      } catch (error) {
        errors.push(`Output '${outputName}' file '${path}': failed to parse: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const validate = compileSchema(arg.json_schema);
      if (!validate(parsed)) {
        const message = validate.errors?.map((item) => `${item.instancePath || "/"} ${item.message}`).join("; ") || "unknown validation error";
        errors.push(`Output '${outputName}' file '${path}': JSON schema validation failed: ${message}`);
      }
    }
  }
  return errors;
}

function buildQualityReviewTasks(input: QualityGateInput): QualityReviewTask[] {
  const tasks: QualityReviewTask[] = [];
  const sourceLocation = sourceLocationFor(input.job, input.projectRoot);

  for (const [outputName, outputRef] of Object.entries(input.step.outputs)) {
    const arg = input.job.step_arguments.find((item) => item.name === outputName);
    if (!arg) continue;
    const value = input.outputs[outputName];
    if (value === undefined || value === null) continue;

    const reviewBlocks: ReviewBlock[] = [];
    if (outputRef.review) reviewBlocks.push(outputRef.review);
    if (arg.review) reviewBlocks.push(arg.review);
    if (reviewBlocks.length === 0) continue;

    reviewBlocks.forEach((reviewBlock, index) => {
      const suffix = outputRef.review && arg.review && index > 0 ? "_arg" : "";
      const ruleName = `step_${input.step.name}_output_${outputName}${suffix}`;
      // Preamble is computed per-block so review_depth: lightweight can suppress Job Context.
      const preamble = buildPreamble(input.step, input.job, input.workflow, input.inputValues, reviewBlock.review_depth);
      const instructions = preamble ? `${preamble}\n\n${reviewBlock.instructions}` : reviewBlock.instructions;
      const filesToReview = arg.type === "file_path" ? filePathValues(value) : [];
      const inlineContent = arg.type === "string" ? String(value) : undefined;
      tasks.push({
        reviewId: reviewId(ruleName, filesToReview, inlineContent, sourceLocation),
        ruleName,
        description: `Review of output '${outputName}' from step '${input.step.name}'`,
        instructions,
        filesToReview,
        ...(inlineContent !== undefined ? { inlineContent } : {}),
        sourceLocation,
      });
    });
  }

  if (input.step.process_requirements && Object.keys(input.step.process_requirements).length > 0 && input.workSummary) {
    const outputFiles = collectOutputFilePaths(input.outputs, input.job);
    const ruleName = `step_${input.step.name}_process_quality`;
    // Process-requirements reviews always use standard depth — never suppress Job Context.
    const preamble = buildPreamble(input.step, input.job, input.workflow, input.inputValues);
    const instructions = buildProcessRequirementsInstructions(input, preamble);
    tasks.push({
      reviewId: reviewId(ruleName, outputFiles, outputFiles.length === 0 ? input.workSummary : undefined, sourceLocation),
      ruleName,
      description: `Process quality review for step '${input.step.name}'`,
      instructions,
      filesToReview: outputFiles,
      ...(outputFiles.length === 0 ? { inlineContent: input.workSummary } : {}),
      sourceLocation,
    });
  }

  return tasks;
}

async function buildOutputFilePolicyTasks(input: QualityGateInput): Promise<ReviewTaskNative[]> {
  const outputFiles = collectOutputFilePaths(input.outputs, input.job);
  if (outputFiles.length === 0) return [];

  const deepreview = await loadAllReviewRules(input.projectRoot);
  const deepschema = await generateDeepSchemaReviewRules(input.projectRoot);
  const rules = [...deepreview.rules, ...deepschema.rules].filter((rule) => rule.cadence === "change_cycle");
  if (rules.length === 0) return [];

  const changedOutputFiles = [...new Set(outputFiles)].sort();
  const tasks: ReviewTaskNative[] = [];
  for (const rule of rules) {
    const ruleTasks = matchFilesToRules(changedOutputFiles, [rule], input.projectRoot, "pi");
    if (rule.unchangedMatchingFiles && ruleTasks.length > 0) {
      const additionalFiles = await findUnchangedMatchingFiles(changedOutputFiles, rule, input.projectRoot);
      for (const task of ruleTasks) task.additionalFiles = additionalFiles;
    }
    tasks.push(...ruleTasks);
  }

  return tasks.map((task) => ({
    ...task,
    instructions: qualityGatePolicyInstructions(task.instructions, input),
  }));
}

function qualityGatePolicyInstructions(instructions: string, input: QualityGateInput): string {
  const preamble = buildPreamble(input.step, input.job, input.workflow, input.inputValues);
  const qualityContext = [
    `This review is being run as a DeepWork workflow quality gate for job '${input.job.name}', workflow '${input.workflow.name}', step '${input.step.name}'.`,
    input.workSummary ? `## Work Summary\n\n${input.workSummary}` : "",
  ].filter(Boolean).join("\n\n");
  return [preamble, qualityContext, instructions].filter(Boolean).join("\n\n");
}

async function writeQualityInstructionFiles(tasks: QualityReviewTask[], projectRoot: string): Promise<Array<{ task: QualityReviewTask; promptFile: string }>> {
  const dir = join(projectRoot, ".deepwork", "tmp", "review_instructions");
  await mkdir(dir, { recursive: true });
  const taskFiles: Array<{ task: QualityReviewTask; promptFile: string }> = [];

  for (const task of tasks) {
    const promptFile = join(dir, `${task.reviewId}.md`);
    if (existsSync(join(dir, `${task.reviewId}.passed`))) continue;
    await writeFile(promptFile, renderInstructionFile(task, projectRoot));
    taskFiles.push({ task, promptFile });
  }

  return taskFiles;
}

function renderInstructionFile(task: QualityReviewTask, projectRoot: string): string {
  const scope = task.inlineContent !== undefined && task.filesToReview.length === 0 ? "inline content" : task.filesToReview.join(", ");
  const sections = [
    `# Review: ${task.ruleName} — ${scope}`,
    "",
    "## Project Root",
    "",
    projectRoot,
    "",
    "Read files from this project root using Pi file-reading tools, even if your current working directory differs.",
    "",
    "## Review Instructions",
    "",
    task.instructions,
    "",
  ];

  if (task.inlineContent !== undefined) {
    sections.push("## Content to Review", "", task.inlineContent, "");
  } else if (task.filesToReview.length > 0) {
    sections.push("## Files to Review", "", ...task.filesToReview.map((file) => `- ${file}`), "");
  }

  sections.push(
    "## After Review",
    "",
    "Report findings with file paths and line references when possible.",
    `If the review passes, call \`deepwork_mark_review_as_passed\` with review_id \`${task.reviewId}\`.`,
    "Do not mark this review as passed when actionable findings remain.",
    "",
    "---",
    "",
    `This review was requested by the policy at \`${task.sourceLocation}\`.`,
    "",
  );

  return sections.join("\n");
}

function buildReviewGuidance(
  taskFiles: Array<{ task: QualityReviewTask; promptFile: string }>,
  policyTaskFiles: WrittenReviewTask[],
  projectRoot: string,
): string {
  const builtInLines = taskFiles
    .map(({ task, promptFile }, index) => [
      `${index + 1}. description: ${task.description}`,
      "   reviewer: deepwork-reviewer",
      `   review_id: ${task.reviewId}`,
      `   prompt_file: ${promptFile}`,
    ].join("\n"))
    .join("\n\n");
  const policyLines = formatReviewTasksForPi(policyTaskFiles, projectRoot);
  const taskSections = [builtInLines, policyTaskFiles.length > 0 ? policyLines : ""].filter(Boolean).join("\n\n");

  const retryWord = REVIEWER_MAX_RETRIES === 1 ? "retry" : "retries";
  const retryInstruction = REVIEWER_MAX_RETRIES === 1 ? "Retry it once" : `Retry it up to ${REVIEWER_MAX_RETRIES} times`;
  const exhaustCondition = REVIEWER_MAX_RETRIES === 1 ? "If the retry also returns" : `If all ${REVIEWER_MAX_RETRIES} retries return`;
  const totalAttempts = REVIEWER_MAX_RETRIES + 1;

  return `Quality reviews are required before this step can advance.\n\n${taskSections}\n\n## How to Run Reviews\n\nFor each review task listed above, launch it as a Pi-native review task or read the prompt_file and follow the review instructions.\n\n## Handling Hung Reviewers\n\nA reviewer has **hung** when it completes with **0 tool uses** — a signal of API overload or a dropped connection. Hung reviewers must be retried; do **not** silently pass them.\n\n**Retry policy (max ${REVIEWER_MAX_RETRIES} ${retryWord} per reviewer)**:\n\n1. After each reviewer completes, check whether it made 0 tool uses and produced no substantive output.\n2. If both are true the reviewer hung. ${retryInstruction} by re-launching the same agent with the same prompt.\n   - If elapsed time was under ${REVIEWER_FAST_FAIL_SECONDS}s the reviewer fast-failed (never got an API response) — retry immediately.\n   - If elapsed time was ${REVIEWER_FAST_FAIL_SECONDS}s or more (slow-hang), the reviewer started but stalled — retry after a brief pause.\n3. ${exhaustCondition} 0 tool uses: call \`deepwork_mark_review_as_passed\` with the review_id. Then tell the user: "Review skipped after ${totalAttempts} failed attempt${totalAttempts === 1 ? "" : "s"} — manual review recommended for this step." Do **not** proceed without informing the user.\n\n## After Reviews\n\nFor any failing reviews where the reviewer produced actual findings: if you believe the issue is invalid, call \`deepwork_mark_review_as_passed\` on it. Otherwise, act on the feedback, fix the issues, and call \`deepwork_finished_step\` again.`;
}

function buildPreamble(step: WorkflowStep, job: JobDefinition, workflow: Workflow, inputValues: Record<string, JsonValue>, reviewDepth?: string): string {
  const parts: string[] = [];
  if (reviewDepth !== "lightweight" && workflow.common_job_info) parts.push(`## Job Context\n\n${workflow.common_job_info}`);
  const inputContext = buildInputContext(step, job, inputValues);
  if (inputContext) parts.push(inputContext);
  return parts.join("\n\n");
}

function buildInputContext(step: WorkflowStep, job: JobDefinition, inputValues: Record<string, JsonValue>): string {
  if (Object.keys(step.inputs).length === 0) return "";
  const lines = ["## Step Inputs", ""];
  for (const inputName of Object.keys(step.inputs)) {
    const arg = job.step_arguments.find((item) => item.name === inputName);
    if (!arg) continue;
    const value = inputValues[inputName];
    if (value === undefined || value === null) lines.push(`- **${inputName}** (${arg.type}): ${arg.description} — *not available*`);
    else lines.push(`- **${inputName}** (${arg.type}): ${String(value)}`);
  }
  return lines.join("\n");
}

function buildProcessRequirementsInstructions(input: QualityGateInput, preamble: string): string {
  const requirements = Object.entries(input.step.process_requirements).map(([name, statement]) => `- **${name}**: ${statement}`).join("\n");
  const outputs = Object.entries(input.outputs).map(([name, value]) => `- **${name}**: ${String(value)}`).join("\n");
  return `${preamble}\n\n## Process Requirements Review\n\nPlease review for compliance with the following requirements. You MUST fail the review for any requirement using MUST/SHALL that is not met. You MUST fail the review for any SHOULD/RECOMMENDED requirement that appears easily achievable but was not followed. You SHOULD give feedback but not fail the review for any other applicable requirements.\n\n## Requirements\n\n${requirements}\n\n## Work Summary (work_summary)\n\n${input.workSummary}\n\n## Step Outputs\n\n${outputs}\n\nEvaluate whether the work described in the work_summary meets each requirement. If an output file helps verify a requirement, read it.`;
}

function collectOutputFilePaths(outputs: Record<string, JsonValue>, job: JobDefinition): string[] {
  const paths: string[] = [];
  for (const [outputName, value] of Object.entries(outputs)) {
    const arg = job.step_arguments.find((item) => item.name === outputName);
    if (arg?.type === "file_path") paths.push(...filePathValues(value));
  }
  return paths;
}

function filePathValues(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function sourceLocationFor(job: JobDefinition, projectRoot: string): string {
  const jobFile = join(job.job_dir, "job.yml");
  const rel = relative(projectRoot, jobFile);
  return rel && !rel.startsWith("..") ? `${rel}:0` : `${jobFile}:0`;
}

function reviewId(ruleName: string, files: string[], inlineContent: string | undefined, sourceLocation: string): string {
  const hash = createHash("sha256").update(JSON.stringify({ ruleName, files, inlineContent, sourceLocation })).digest("hex").slice(0, 12);
  return `${ruleName}_${hash}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const AjvCtor = AjvModule as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: unknown): ValidateFunction };
  return new AjvCtor({ allErrors: true, strict: false }).compile(schema);
}
