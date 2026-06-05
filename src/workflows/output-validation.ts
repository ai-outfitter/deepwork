import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { JsonValue } from "../bridge.js";
import type { JobDefinition, WorkflowStep } from "../types/workflows.js";
import { WorkflowRuntimeError } from "./errors.js";

export function validateStepOutputs(
  job: JobDefinition,
  step: WorkflowStep,
  outputs: Record<string, JsonValue>,
  projectRoot: string,
): void {
  const declared = Object.keys(step.outputs);
  const unknown = Object.keys(outputs).filter((name) => !declared.includes(name));
  if (unknown.length > 0) {
    throw new WorkflowRuntimeError(`Unknown output names: ${unknown.join(", ")}. Declared outputs: ${declared.join(", ")}`, "ToolError");
  }

  for (const [name, outputRef] of Object.entries(step.outputs)) {
    if (outputRef.required && !(name in outputs)) {
      throw new WorkflowRuntimeError(`Missing required output: ${name}`, "ToolError");
    }
    if (!(name in outputs)) continue;

    const arg = job.step_arguments.find((item) => item.name === name);
    const value = outputs[name];
    if (arg?.type === "string" && typeof value !== "string") {
      throw new WorkflowRuntimeError(`Output '${name}' must be a string`, "ToolError");
    }
    if (arg?.type === "file_path") validateFilePathOutput(name, value, projectRoot);
  }
}

function validateFilePathOutput(name: string, value: JsonValue, projectRoot: string): void {
  const paths = Array.isArray(value) ? value : [value];
  if (!paths.every((item) => typeof item === "string")) {
    throw new WorkflowRuntimeError(`Output '${name}' must be a file path string or list of file path strings`, "ToolError");
  }

  for (const path of paths as string[]) {
    const fullPath = isAbsolute(path) ? path : join(projectRoot, path);
    if (!existsSync(fullPath)) {
      throw new WorkflowRuntimeError(`Output '${name}' file path does not exist: ${path}`, "ToolError");
    }
  }
}
