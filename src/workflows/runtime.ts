import { resolve } from "node:path";
import type { JsonObject, JsonValue } from "../bridge.js";
import type { JobDefinition, StepArgument, Workflow, WorkflowStep } from "../types/workflows.js";
import { getJobFolders, getWorkflowsNative, parseJobDefinition } from "./discovery.js";
import { WorkflowRuntimeError } from "./errors.js";
import { validateStepOutputs } from "./output-validation.js";
import { runQualityGateNative } from "./quality-gates.js";
import { getWorkflowSession, updateWorkflowSession, workflowStack, type ActiveWorkflowFrame, type WorkflowSessionState } from "./state.js";
import { writeStatusManifest } from "./status.js";

const IMPORTANT_NOTE = "IMPORTANT: If, given the info on the workflow you now have, the user's request seems ambiguous and can be interpreted several ways, you MUST use AskUserQuestion to clarify their intent if that tool is available.";

export { WorkflowRuntimeError } from "./errors.js";

export async function startWorkflowNative(params: JsonObject, options: { cwd: string; sessionId?: string; agentId?: string }): Promise<JsonValue> {
  const projectRoot = resolve(options.cwd);
  const sessionId = String(params.session_id ?? options.sessionId ?? "default");
  const goal = requiredString(params.goal, "goal");
  const jobName = requiredString(params.job_name, "job_name");
  const workflowNameParam = requiredString(params.workflow_name, "workflow_name");
  const inputs = asObject(params.inputs ?? {});

  const job = await getJob(projectRoot, jobName, sessionId, options.agentId);
  const workflowName = selectWorkflow(job, workflowNameParam);
  const workflow = job.workflows[workflowName];
  if (workflow.steps.length === 0) throw new WorkflowRuntimeError(`Workflow '${workflowName}' has no steps`, "ToolError");

  const frame: ActiveWorkflowFrame = {
    session_id: sessionId,
    goal,
    job_name: job.name,
    workflow_name: workflowName,
    job_dir: job.job_dir,
    current_step_index: 0,
    initial_inputs: inputs,
    outputs: {},
    completed_steps: [],
    step_names: workflow.steps.map((step) => step.name),
  };

  const session = await updateWorkflowSession(projectRoot, sessionId, (current) => {
    current.stack.push(frame);
  });
  await writeStatusManifest(projectRoot, sessionId, session);

  return withIssues(projectRoot, {
    important_note: IMPORTANT_NOTE,
    begin_step: beginStep(projectRoot, job, workflow, frame, workflow.steps[0], inputs),
    stack: workflowStack(session),
  });
}

export async function finishedStepNative(params: JsonObject, options: { cwd: string; sessionId?: string; agentId?: string }): Promise<JsonValue> {
  const projectRoot = resolve(options.cwd);
  const sessionId = String(params.session_id ?? options.sessionId ?? "default");
  const outputs = asObject(params.outputs ?? {});
  const session = await getWorkflowSession(projectRoot, sessionId);
  const frame = activeFrame(session);
  if (!frame) throw noActiveSessionError();

  const job = await getJob(projectRoot, frame.job_name, sessionId, options.agentId);
  const workflow = job.workflows[frame.workflow_name];
  const step = workflow.steps[frame.current_step_index];
  validateStepOutputs(job, step, outputs, projectRoot);

  if (!params.quality_review_override_reason) {
    const reviewFeedback = await runQualityGateNative({
      step,
      job,
      workflow,
      outputs,
      inputValues: resolveInputs(step, frame, false),
      workSummary: typeof params.work_summary === "string" ? params.work_summary : null,
      projectRoot,
    });

    if (reviewFeedback) {
      frame.quality_attempts = {
        ...(frame.quality_attempts ?? {}),
        [step.name]: (frame.quality_attempts?.[step.name] ?? 0) + 1,
      };
      await updateWorkflowSession(projectRoot, sessionId, (current) => {
        current.stack = session.stack;
      });
      await writeStatusManifest(projectRoot, sessionId, session);
      return withIssues(projectRoot, {
        status: "needs_work",
        feedback: reviewFeedback,
        stack: workflowStack(session),
      });
    }
  }

  Object.assign(frame.outputs, outputs);
  if (!frame.completed_steps.includes(step.name)) frame.completed_steps.push(step.name);

  if (frame.current_step_index >= workflow.steps.length - 1) {
    session.stack.pop();
    await updateWorkflowSession(projectRoot, sessionId, (current) => {
      current.stack = session.stack;
    });
    await writeStatusManifest(projectRoot, sessionId, session);
    return withIssues(projectRoot, {
      status: "workflow_complete",
      feedback: null,
      begin_step: null,
      summary: `Workflow '${frame.workflow_name}' completed successfully!`,
      all_outputs: frame.outputs,
      post_workflow_instructions: workflow.post_workflow_instructions ?? null,
      stack: workflowStack(session),
    });
  }

  frame.current_step_index += 1;
  const nextStep = workflow.steps[frame.current_step_index];
  const nextInputs = resolveInputs(nextStep, frame, false);
  await updateWorkflowSession(projectRoot, sessionId, (current) => {
    current.stack = session.stack;
  });
  await writeStatusManifest(projectRoot, sessionId, session);

  return withIssues(projectRoot, {
    status: "next_step",
    feedback: null,
    begin_step: beginStep(projectRoot, job, workflow, frame, nextStep, nextInputs),
    summary: null,
    all_outputs: null,
    post_workflow_instructions: null,
    stack: workflowStack(session),
  });
}

export async function abortWorkflowNative(params: JsonObject, options: { cwd: string; sessionId?: string; agentId?: string }): Promise<JsonValue> {
  const projectRoot = resolve(options.cwd);
  const sessionId = String(params.session_id ?? options.sessionId ?? "default");
  const explanation = requiredString(params.explanation, "explanation");
  const session = await getWorkflowSession(projectRoot, sessionId);
  const frame = activeFrame(session);
  if (!frame) throw noActiveSessionError();

  const job = await getJob(projectRoot, frame.job_name, sessionId, options.agentId);
  const workflow = job.workflows[frame.workflow_name];
  const abortedStep = workflow.steps[frame.current_step_index]?.name ?? null;
  const abortedWorkflow = `${frame.job_name}/${frame.workflow_name}`;
  session.stack.pop();
  await updateWorkflowSession(projectRoot, sessionId, (current) => {
    current.stack = session.stack;
  });
  await writeStatusManifest(projectRoot, sessionId, session);
  const resumed = activeFrame(session);

  return withIssues(projectRoot, {
    aborted_workflow: abortedWorkflow,
    aborted_step: abortedStep,
    explanation,
    stack: workflowStack(session),
    resumed_workflow: resumed ? `${resumed.job_name}/${resumed.workflow_name}` : null,
    resumed_step: resumed ? (resumed.step_names ?? resumed.completed_steps)[resumed.current_step_index] ?? null : null,
  });
}

export async function goToStepNative(params: JsonObject, options: { cwd: string; sessionId?: string; agentId?: string }): Promise<JsonValue> {
  const projectRoot = resolve(options.cwd);
  const sessionId = String(params.session_id ?? options.sessionId ?? "default");
  const stepId = requiredString(params.step_id, "step_id");
  const session = await getWorkflowSession(projectRoot, sessionId);
  const frame = activeFrame(session);
  if (!frame) throw noActiveSessionError();

  const job = await getJob(projectRoot, frame.job_name, sessionId, options.agentId);
  const workflow = job.workflows[frame.workflow_name];
  const targetIndex = workflow.steps.findIndex((step) => step.name === stepId);
  const available = workflow.steps.map((step) => step.name);
  if (targetIndex < 0) throw new WorkflowRuntimeError(`Step '${stepId}' not found. Available steps: ${available.join(", ")}`, "ToolError");
  if (targetIndex > frame.current_step_index) {
    throw new WorkflowRuntimeError(`Cannot go forward to step '${stepId}' (index ${targetIndex} > current ${frame.current_step_index}). Use finished_step to advance forward.`, "ToolError");
  }

  const invalidatedSteps = workflow.steps.slice(targetIndex).map((step) => step.name);
  for (const step of workflow.steps.slice(targetIndex)) {
    for (const outputName of Object.keys(step.outputs)) delete frame.outputs[outputName];
  }
  frame.current_step_index = targetIndex;
  frame.completed_steps = frame.completed_steps.filter((name) => !invalidatedSteps.includes(name));
  const step = workflow.steps[targetIndex];
  const inputs = resolveInputs(step, frame, true);

  await updateWorkflowSession(projectRoot, sessionId, (current) => {
    current.stack = session.stack;
  });
  await writeStatusManifest(projectRoot, sessionId, session);

  return withIssues(projectRoot, {
    begin_step: beginStep(projectRoot, job, workflow, frame, step, inputs),
    invalidated_steps: invalidatedSteps,
    stack: workflowStack(session),
  });
}

async function getJob(projectRoot: string, jobName: string, sessionId?: string, agentId?: string): Promise<JobDefinition> {
  for (const folder of await getJobFolders(projectRoot, { sessionId, agentId })) {
    const jobDir = `${folder}/${jobName}`;
    try {
      return await parseJobDefinition(jobDir);
    } catch (error) {
      if (error instanceof Error && /Job directory does not exist|job\.yml not found/.test(error.message)) continue;
      throw error;
    }
  }
  throw new WorkflowRuntimeError(`Job not found: ${jobName}`, "ToolError");
}

function selectWorkflow(job: JobDefinition, requested: string): string {
  if (job.workflows[requested]) return requested;
  const workflowNames = Object.keys(job.workflows);
  if (workflowNames.length === 1) return workflowNames[0];
  throw new WorkflowRuntimeError(`Workflow not found: ${requested}. Available workflows: ${workflowNames.join(", ")}`, "ToolError");
}

function beginStep(
  projectRoot: string,
  job: JobDefinition,
  workflow: Workflow,
  frame: ActiveWorkflowFrame,
  step: WorkflowStep,
  inputValues: Record<string, JsonValue>,
): JsonObject {
  return {
    session_id: frame.session_id,
    step_id: step.name,
    project_root: projectRoot,
    job_dir: job.job_dir,
    step_expected_outputs: Object.entries(step.outputs).map(([name, ref]) => {
      const arg = requiredArgument(job, name);
      return {
        name,
        type: arg.type,
        description: arg.description,
        required: ref.required,
        syntax_for_finished_step_tool: arg.type === "file_path" ? "file path string" : "string value",
      };
    }),
    step_inputs: Object.entries(step.inputs).map(([name, ref]) => {
      const arg = requiredArgument(job, name);
      return {
        name,
        type: arg.type,
        description: arg.description,
        value: inputValues[name] ?? null,
        required: ref.required,
      };
    }),
    step_instructions: renderStepInstructions(job, step, inputValues),
    common_job_info: workflow.common_job_info ?? null,
  };
}

function renderStepInstructions(job: JobDefinition, step: WorkflowStep, inputs: Record<string, JsonValue>): string {
  const lines = ["## Inputs", ""];
  for (const [name, ref] of Object.entries(step.inputs)) {
    const arg = requiredArgument(job, name);
    if (inputs[name] === undefined || inputs[name] === null) {
      lines.push(`- **${name}** (${ref.required ? "required" : "optional"}): ${arg.description} — *not yet available*`);
    } else {
      lines.push(`- **${name}** (${ref.required ? "required" : "optional"}): ${String(inputs[name])}`);
    }
  }
  lines.push("", step.instructions ?? "");
  return lines.join("\n");
}

function resolveInputs(step: WorkflowStep, frame: ActiveWorkflowFrame, afterInvalidation: boolean): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const name of Object.keys(step.inputs)) {
    if (name in frame.outputs) values[name] = frame.outputs[name];
    else if (!afterInvalidation && name in frame.initial_inputs) values[name] = frame.initial_inputs[name];
    else values[name] = null;
  }
  return values;
}

function requiredArgument(job: JobDefinition, name: string): StepArgument {
  const arg = job.step_arguments.find((item) => item.name === name);
  if (!arg) throw new WorkflowRuntimeError(`Step argument not found: ${name}`, "ToolError");
  return arg;
}

function activeFrame(session: WorkflowSessionState): ActiveWorkflowFrame | null {
  return session.stack.at(-1) ?? null;
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new WorkflowRuntimeError(`Missing required string parameter: ${name}`, "ToolError");
  return value;
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function noActiveSessionError(): WorkflowRuntimeError {
  return new WorkflowRuntimeError("No active workflow session. The finished_step tool reports completion of a step within a running workflow. If you want to resume a workflow, just start it again and call finished_step with quality_review_override_reason until you get back to your prior step.", "ToolError");
}

async function withIssues(projectRoot: string, value: JsonObject): Promise<JsonObject> {
  const workflows = await getWorkflowsNative(projectRoot);
  if (typeof workflows.issue_detected === "string") value.issue_detected = workflows.issue_detected;
  return value;
}
