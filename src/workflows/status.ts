import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getJobFolders, parseJobDefinition } from "./discovery.js";
import { loadWorkflowState, type ActiveWorkflowFrame, type WorkflowSessionState } from "./state.js";
import { workflowStack } from "./state.js";
import type { JobDefinition, Workflow, WorkflowStep } from "../types/workflows.js";

export async function writeStatusManifest(projectRoot: string, sessionId: string, session: WorkflowSessionState): Promise<void> {
  try {
    const dir = join(projectRoot, ".deepwork", "status");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "pi-workflows.json"),
      `${JSON.stringify({ session_id: sessionId, stack: workflowStack(session) }, null, 2)}\n`,
    );
  } catch {
    // Status manifests are best-effort and must not break workflow tool calls.
  }
}

export async function getActiveWorkflowStackNative(projectRoot: string): Promise<string | null> {
  const root = resolve(projectRoot);
  const state = await loadWorkflowState(root);
  const activeSessions = Object.entries(state.sessions).filter(([, session]) => session.stack.length > 0);
  if (activeSessions.length === 0) return null;

  const sections = ["Active DeepWork workflow stack:"];
  for (const [sessionId, session] of activeSessions) {
    sections.push("", `## Session ${sessionId}`, "", "```json", JSON.stringify(workflowStack(session), null, 2), "```");

    const frame = session.stack.at(-1);
    if (!frame) continue;
    const context = await frameContext(root, frame);
    sections.push(
      "",
      `Workflow: ${frame.job_name}/${frame.workflow_name}`,
      `Goal: ${frame.goal}`,
      `Current step: ${context.currentStepName}`,
      `Completed steps: ${context.completedSteps.length > 0 ? context.completedSteps.join(", ") : "none"}`,
    );
    if (context.commonJobInfo) sections.push("", "Common job info:", context.commonJobInfo);
    if (context.currentStepInstructions) sections.push("", "Current step instructions:", context.currentStepInstructions);
  }

  return sections.join("\n");
}

async function frameContext(projectRoot: string, frame: ActiveWorkflowFrame): Promise<{
  currentStepName: string;
  completedSteps: string[];
  commonJobInfo: string | null;
  currentStepInstructions: string | null;
}> {
  try {
    const job = await getJob(projectRoot, frame.job_name);
    const workflow = job.workflows[frame.workflow_name];
    const step = workflow?.steps[frame.current_step_index];
    return {
      currentStepName: step?.name ?? "unknown",
      completedSteps: completedStepNames(workflow, frame),
      commonJobInfo: workflow?.common_job_info ?? null,
      currentStepInstructions: renderInstructions(step),
    };
  } catch {
    return {
      currentStepName: "unknown",
      completedSteps: [],
      commonJobInfo: null,
      currentStepInstructions: null,
    };
  }
}

async function getJob(projectRoot: string, jobName: string): Promise<JobDefinition> {
  for (const folder of await getJobFolders(projectRoot)) {
    try {
      return await parseJobDefinition(join(folder, jobName));
    } catch (error) {
      if (error instanceof Error && /Job directory does not exist|job\.yml not found/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error(`Job not found: ${jobName}`);
}

function completedStepNames(workflow: Workflow | undefined, frame: ActiveWorkflowFrame): string[] {
  if (!workflow) return [];
  return workflow.steps.slice(0, frame.current_step_index).map((step) => step.name);
}

function renderInstructions(step: WorkflowStep | undefined): string | null {
  if (!step) return null;
  return step.instructions ?? (step.sub_workflow ? `Sub-workflow: ${step.sub_workflow.workflow_job ? `${step.sub_workflow.workflow_job}/` : ""}${step.sub_workflow.workflow_name}` : null);
}
