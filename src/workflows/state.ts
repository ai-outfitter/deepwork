import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type WorkflowStackEntry = {
  workflow: string;
  step: string;
};

export type ActiveWorkflowFrame = {
  session_id: string;
  goal: string;
  job_name: string;
  workflow_name: string;
  job_dir: string;
  current_step_index: number;
  initial_inputs: Record<string, JsonValue>;
  outputs: Record<string, JsonValue>;
  completed_steps: string[];
  step_names?: string[];
  quality_attempts?: Record<string, number>;
};

export type WorkflowSessionState = {
  stack: ActiveWorkflowFrame[];
};

export type WorkflowStateFile = {
  sessions: Record<string, WorkflowSessionState>;
};

const EMPTY_STATE: WorkflowStateFile = { sessions: {} };

export async function loadWorkflowState(projectRoot: string): Promise<WorkflowStateFile> {
  try {
    const raw = await readFile(statePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as WorkflowStateFile;
    return { sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}

export async function saveWorkflowState(projectRoot: string, state: WorkflowStateFile): Promise<void> {
  const path = statePath(projectRoot);
  await mkdir(join(projectRoot, ".deepwork", "state"), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function getWorkflowSession(projectRoot: string, sessionId: string): Promise<WorkflowSessionState> {
  const state = await loadWorkflowState(projectRoot);
  return state.sessions[sessionId] ?? { stack: [] };
}

export async function updateWorkflowSession(
  projectRoot: string,
  sessionId: string,
  update: (session: WorkflowSessionState, state: WorkflowStateFile) => void,
): Promise<WorkflowSessionState> {
  const state = await loadWorkflowState(projectRoot);
  const session = state.sessions[sessionId] ?? { stack: [] };
  state.sessions[sessionId] = session;
  update(session, state);
  if (session.stack.length === 0) delete state.sessions[sessionId];
  await saveWorkflowState(projectRoot, state.sessions ? state : EMPTY_STATE);
  return session;
}

export function workflowStack(session: WorkflowSessionState): WorkflowStackEntry[] {
  return session.stack.map((frame) => ({
    workflow: `${frame.job_name}/${frame.workflow_name}`,
    step: frameStepName(frame),
  }));
}

export function frameStepName(frame: ActiveWorkflowFrame): string {
  return (frame.step_names ?? frame.completed_steps)[frame.current_step_index] ?? "";
}

function statePath(projectRoot: string): string {
  return join(projectRoot, ".deepwork", "state", "pi-workflows.json");
}
