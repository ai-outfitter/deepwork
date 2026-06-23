import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkflowsNative } from "./workflows/discovery.js";
import { getConfiguredReviewsNative, getReviewInstructionsNative, hasUnpassedReviewForCurrentChanges } from "./reviews/tools.js";
import { getActiveWorkflowStackNative } from "./workflows/status.js";
import { getNamedSchemasNative } from "./deepschema/tools.js";
import { runDeepSchemaWriteHookNative } from "./deepschema/write-hook.js";
import {
  abortWorkflowNative,
  finishedStepNative,
  goToStepNative,
  startWorkflowNative,
  WorkflowRuntimeError,
} from "./workflows/runtime.js";
import { getSessionJobNative, registerSessionJobNative } from "./workflows/session-jobs.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type BridgeOptions = {
  cwd: string;
  sessionId?: string;
  agentId?: string;
};

export type ReviewTask = {
  description: string;
  reviewer: string;
  promptFile: string;
  reviewId?: string;
  ruleName?: string;
  filesToReview?: string[];
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type BridgeEnvelope =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string; error_type?: string; traceback?: string };

const PYTHON_BRIDGE = String.raw`
import asyncio
import json
import shutil
import sys
import traceback
from pathlib import Path


def _jsonable(value):
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    return value


def _ensure_schema_available(project_root):
    try:
        from deepwork.jobs.schema import get_schema_path
        target_dir = project_root / ".deepwork"
        target_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(get_schema_path(), target_dir / "job.schema.json")
    except Exception:
        pass


def _format_issues(project_root):
    try:
        from deepwork.jobs.issues import detect_issues, format_issues_for_agent
        issues = detect_issues(project_root)
    except Exception:
        return None
    if not issues:
        return None
    return "\n\n---\n**IMPORTANT: ISSUE DETECTED.** Suggest repairing this immediately to the user.\n\n" + format_issues_for_agent(issues)


def _append_issues(project_root, result):
    if isinstance(result, dict):
        warning = _format_issues(project_root)
        if warning:
            result["issue_detected"] = warning
    return result


async def _workflow_tool(operation, root, params):
    from deepwork.jobs.mcp.schemas import AbortWorkflowInput, FinishedStepInput, GoToStepInput, StartWorkflowInput
    from deepwork.jobs.mcp.state import StateManager
    from deepwork.jobs.mcp.status import StatusWriter
    from deepwork.jobs.mcp.tools import WorkflowTools

    _ensure_schema_available(root)
    state_manager = StateManager(project_root=root, platform="pi")
    tools = WorkflowTools(project_root=root, state_manager=state_manager, status_writer=StatusWriter(root))

    if operation == "get_workflows":
        return _append_issues(root, tools.get_workflows().model_dump())
    if operation == "start_workflow":
        return _append_issues(root, (await tools.start_workflow(StartWorkflowInput(**params))).model_dump())
    if operation == "finished_step":
        return _append_issues(root, (await tools.finished_step(FinishedStepInput(**params))).model_dump())
    if operation == "abort_workflow":
        return _append_issues(root, (await tools.abort_workflow(AbortWorkflowInput(**params))).model_dump())
    if operation == "go_to_step":
        return _append_issues(root, (await tools.go_to_step(GoToStepInput(**params))).model_dump())
    raise ValueError(f"Unsupported workflow operation: {operation}")


def _named_schemas(root):
    from deepwork.deepschema.config import DeepSchemaError, parse_deepschema_file
    from deepwork.deepschema.discovery import find_named_schemas

    results = []
    for manifest_path in find_named_schemas(root):
        name = manifest_path.parent.name
        try:
            schema = parse_deepschema_file(manifest_path, "named", name)
            results.append({"name": schema.name, "summary": schema.summary or "", "matchers": schema.matchers})
        except DeepSchemaError:
            results.append({"name": name, "summary": f"(failed to parse {manifest_path})", "matchers": []})
    return results


async def main():
    request = json.loads(sys.stdin.read() or "{}")
    operation = request.get("operation")
    root = Path(request.get("cwd") or ".").resolve()
    params = request.get("params") or {}

    try:
        if operation in {"get_workflows", "start_workflow", "finished_step", "abort_workflow", "go_to_step"}:
            result = await _workflow_tool(operation, root, params)
        elif operation == "get_review_instructions":
            from deepwork.review.mcp import ReviewToolError, run_review
            try:
                result = run_review(root, "pi", params.get("files"))
            except ReviewToolError as exc:
                # Older DeepWork builds do not yet have a Pi review renderer. Keep the Pi-facing
                # interface native by falling back inside this bridge rather than asking Pi to use MCP.
                if "Unsupported platform" in str(exc) and "pi" in str(exc):
                    result = run_review(root, "codex", params.get("files"))
                else:
                    result = f"Review error: {exc}"
        elif operation == "get_configured_reviews":
            from deepwork.review.mcp import get_configured_reviews
            files = params.get("only_rules_matching_files", params.get("files"))
            result = get_configured_reviews(root, files)
        elif operation == "mark_review_as_passed":
            from deepwork.review.mcp import mark_passed
            result = mark_passed(root, params.get("review_id") or "")
        elif operation == "get_named_schemas":
            result = _named_schemas(root)
        else:
            raise ValueError(f"Unsupported operation: {operation}")
        print(json.dumps({"ok": True, "result": _jsonable(result)}))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "error_type": type(exc).__name__, "traceback": traceback.format_exc()}))

asyncio.run(main())
`;

export class DeepWorkBridgeError extends Error {
  constructor(
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message);
    this.name = "DeepWorkBridgeError";
  }
}

export async function getWorkflows(options: BridgeOptions): Promise<JsonValue> {
  return getWorkflowsNative(options.cwd, { ...options, sessionId: options.sessionId ?? "default" });
}

export async function getWorkflowsFromPythonBridge(options: BridgeOptions): Promise<JsonValue> {
  return normalizeWorkflowInvocationText(await callBridge("get_workflows", {}, options));
}

export async function startWorkflow(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  return callNativeWorkflow(() => startWorkflowNative(withIdentity(params, options), options));
}

export async function finishedStep(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  return callNativeWorkflow(() => finishedStepNative(withIdentity(params, options), options));
}

export async function abortWorkflow(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  return callNativeWorkflow(() => abortWorkflowNative(withIdentity(params, options), options));
}

export async function goToStep(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  return callNativeWorkflow(() => goToStepNative(withIdentity(params, options), options));
}

export async function registerSessionJob(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  return registerSessionJobNative(withIdentity(params, options), options);
}

export async function getSessionJob(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  return getSessionJobNative(withIdentity(params, options), options);
}

export async function getReviewInstructions(params: JsonObject, options: BridgeOptions): Promise<string> {
  try {
    return await getReviewInstructionsNative(params, options.cwd);
  } catch (error) {
    if (process.env.DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK === "1") throw error;
    return String(await callBridge("get_review_instructions", params, options));
  }
}

export async function getReviewInstructionsFromPythonBridge(params: JsonObject, options: BridgeOptions): Promise<string> {
  return String(await callBridge("get_review_instructions", params, options));
}

export async function getConfiguredReviews(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  try {
    return await getConfiguredReviewsNative(params, options.cwd);
  } catch (error) {
    if (process.env.DEEPWORK_PI_DISABLE_REVIEW_PYTHON_FALLBACK === "1") throw error;
    return callBridge("get_configured_reviews", params, options);
  }
}

export async function getConfiguredReviewsFromPythonBridge(params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  return callBridge("get_configured_reviews", params, options);
}

export async function markReviewAsPassed(params: JsonObject, options: BridgeOptions): Promise<string> {
  const reviewId = String(params.review_id ?? "").trim();
  if (!reviewId) throw new DeepWorkBridgeError("review_id must not be empty.", { error_type: "ValueError" });
  if (reviewId.includes("..") || reviewId.startsWith("/")) throw new DeepWorkBridgeError("review_id must not contain path traversal sequences.", { error_type: "ValueError" });
  const instructionsDir = join(options.cwd, ".deepwork", "tmp", "review_instructions");
  await mkdir(instructionsDir, { recursive: true });
  await writeFile(join(instructionsDir, `${reviewId}.passed`), "");
  return `Review '${reviewId}' marked as passed.`;
}

export async function getNamedSchemas(options: BridgeOptions): Promise<JsonValue> {
  return getNamedSchemasNative(options.cwd);
}

export async function getNamedSchemasFromPythonBridge(options: BridgeOptions): Promise<JsonValue> {
  return callBridge("get_named_schemas", {}, options);
}

export async function getActiveWorkflowStack(cwd: string): Promise<string | null> {
  return getActiveWorkflowStackNative(cwd);
}

export async function runDeepSchemaWriteHook(cwd: string, toolName: string, filePath: string): Promise<string | null> {
  try {
    return await runDeepSchemaWriteHookNative(cwd, toolName, filePath);
  } catch (error) {
    if (process.env.DEEPWORK_PI_DISABLE_DEEPSCHEMA_PYTHON_FALLBACK === "1") throw error;
    return runDeepSchemaWriteHookFromPythonBridge(cwd, toolName, filePath);
  }
}

export async function runDeepSchemaWriteHookFromPythonBridge(cwd: string, toolName: string, filePath: string): Promise<string | null> {
  const result = await runCommand(
    "uvx",
    ["deepwork", "hook", "deepschema_write"],
    cwd,
    JSON.stringify({
      hook_event_name: "tool_result",
      cwd,
      tool_name: toolName,
      tool_input: { file_path: filePath },
    }),
    { DEEPWORK_HOOK_PLATFORM: "pi" },
  );
  if (result.code !== 0 || !result.stdout.trim()) return null;

  try {
    const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } };
    return output.hookSpecificOutput?.additionalContext ? String(output.hookSpecificOutput.additionalContext) : null;
  } catch {
    return null;
  }
}

export async function hasApplicableReviews(cwd: string): Promise<boolean> {
  return hasUnpassedReviewForCurrentChanges(cwd);
}

export function parseReviewTasks(output: string): ReviewTask[] {
  const tasks: ReviewTask[] = [];
  let current: Partial<ReviewTask> = {};

  const flush = () => {
    if (current.description && current.reviewer && current.promptFile) {
      tasks.push({
        description: current.description,
        reviewer: current.reviewer,
        promptFile: current.promptFile,
        ...(current.reviewId ? { reviewId: current.reviewId } : {}),
        ...(current.ruleName ? { ruleName: current.ruleName } : {}),
        ...(current.filesToReview ? { filesToReview: current.filesToReview } : {}),
      });
    }
    current = {};
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("description: ")) {
      flush();
      current.description = line.slice("description: ".length).trim();
    } else if (line.trimStart().startsWith("reviewer: ")) {
      current.reviewer = line.trim().slice("reviewer: ".length).trim();
    } else if (line.trimStart().startsWith("prompt_file: ")) {
      current.promptFile = line.trim().slice("prompt_file: ".length).trim();
    } else if (line.trimStart().startsWith("review_id: ")) {
      current.reviewId = line.trim().slice("review_id: ".length).trim();
    } else if (line.trimStart().startsWith("rule_name: ")) {
      current.ruleName = line.trim().slice("rule_name: ".length).trim();
    } else if (line.trimStart().startsWith("files_to_review: ")) {
      const value = line.trim().slice("files_to_review: ".length).trim();
      current.filesToReview = value.length > 0 ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
    }
  }
  flush();

  return tasks;
}

async function callNativeWorkflow(run: () => Promise<JsonValue>): Promise<JsonValue> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkflowRuntimeError) {
      throw new DeepWorkBridgeError(error.message, { error_type: error.errorType });
    }
    throw error;
  }
}

async function callBridge(operation: string, params: JsonObject, options: BridgeOptions): Promise<JsonValue> {
  const result = await runCommand(
    "uvx",
    ["--from", "deepwork", "python", "-c", PYTHON_BRIDGE],
    options.cwd,
    JSON.stringify({ operation, cwd: options.cwd, params }),
  );

  if (result.code !== 0) {
    throw new DeepWorkBridgeError(`DeepWork bridge command failed for ${operation}.`, {
      command: "uvx --from deepwork python -c <bridge>",
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  let envelope: BridgeEnvelope;
  try {
    envelope = JSON.parse(result.stdout.trim()) as BridgeEnvelope;
  } catch (error) {
    throw new DeepWorkBridgeError(`DeepWork bridge returned non-JSON output for ${operation}.`, {
      stdout: result.stdout,
      stderr: result.stderr,
      parse_error: String(error),
    });
  }

  if (!envelope.ok) {
    const errorEnvelope = envelope as Extract<BridgeEnvelope, { ok: false }>;
    throw new DeepWorkBridgeError(errorEnvelope.error, {
      error_type: errorEnvelope.error_type ?? "Error",
      traceback: errorEnvelope.traceback ?? "",
    });
  }

  return envelope.result;
}

function withIdentity(params: JsonObject, options: BridgeOptions): JsonObject {
  const next: JsonObject = { ...params };
  if (!next.session_id && options.sessionId) next.session_id = options.sessionId;
  if (!next.agent_id && options.agentId) next.agent_id = options.agentId;
  return next;
}

function normalizeWorkflowInvocationText(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const response = value as JsonObject;
  const jobs = response.jobs;
  if (!Array.isArray(jobs)) return value;

  for (const job of jobs) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    const workflows = (job as JsonObject).workflows;
    if (!Array.isArray(workflows)) continue;
    for (const workflow of workflows) {
      if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) continue;
      const workflowInfo = workflow as JsonObject;
      if (typeof workflowInfo.how_to_invoke !== "string") continue;
      workflowInfo.how_to_invoke = workflowInfo.how_to_invoke
        .replace(/mcp__plugin_deepwork_deepwork__start_workflow/g, "deepwork_start_workflow")
        .replace(/mcp__[^\s`]*__start_workflow/g, "deepwork_start_workflow")
        .replace(/mcp__[^\s`]*__register_session_job/g, "deepwork_register_session_job")
        .replace(/mcp__[^\s`]*__get_session_job/g, "deepwork_get_session_job")
        .replace(/(?<!deepwork_)start_workflow/g, "deepwork_start_workflow")
        .replace(/(?<!deepwork_)finished_step/g, "deepwork_finished_step")
        .replace(/(?<!deepwork_)abort_workflow/g, "deepwork_abort_workflow")
        .replace(/(?<!deepwork_)go_to_step/g, "deepwork_go_to_step")
        .replace(/(?<!deepwork_)register_session_job/g, "deepwork_register_session_job")
        .replace(/(?<!deepwork_)get_session_job/g, "deepwork_get_session_job");
    }
  }
  return response;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  stdin?: string,
  env?: Record<string, string>,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolveResult({ code: 1, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}
