import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { JsonObject, JsonValue } from "../bridge.js";
import { parseJobDefinition } from "./discovery.js";
import { WorkflowRuntimeError } from "./errors.js";
import { sessionJobsDir, type SessionJobIdentity } from "./session-job-paths.js";

const JOB_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export async function registerSessionJobNative(params: JsonObject, options: { cwd: string; sessionId?: string; agentId?: string }): Promise<JsonObject> {
  const projectRoot = resolve(options.cwd);
  const identity = sessionIdentity(params, options);
  const jobName = requiredJobName(params.job_name);
  const jobDefinitionYaml = requiredJobDefinitionYaml(params);
  const jobDir = join(sessionJobsDir(projectRoot, identity), jobName);
  const jobFile = join(jobDir, "job.yml");

  validateYamlSyntax(jobDefinitionYaml);
  await mkdir(jobDir, { recursive: true });
  await writeFile(jobFile, jobDefinitionYaml);

  try {
    const parsed = await parseJobDefinition(jobDir);
    if (parsed.name !== jobName) {
      throw new WorkflowRuntimeError(`Job definition name '${parsed.name}' must match registered job_name '${jobName}'.`, "ToolError");
    }
    return {
      status: "registered",
      job_name: jobName,
      job_dir: parsed.job_dir,
      session_id: identity.sessionId,
      workflow_names: Object.keys(parsed.workflows),
      message: `Session job '${jobName}' registered successfully. It can be started with deepwork_start_workflow(job_name='${jobName}', ...).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowRuntimeError(
      `Job definition validation failed: ${message}\nThe file was written to ${jobFile} for inspection. Fix the issues and call deepwork_register_session_job again.`,
      "ToolError",
    );
  }
}

export async function getSessionJobNative(params: JsonObject, options: { cwd: string; sessionId?: string; agentId?: string }): Promise<JsonObject> {
  const projectRoot = resolve(options.cwd);
  const identity = sessionIdentity(params, options);
  const jobName = requiredJobName(params.job_name);
  const jobDir = join(sessionJobsDir(projectRoot, identity), jobName);
  const jobFile = join(jobDir, "job.yml");

  let jobDefinitionYaml: string;
  try {
    jobDefinitionYaml = await readFile(jobFile, "utf8");
  } catch {
    throw new WorkflowRuntimeError(`Session job '${jobName}' not found for session '${identity.sessionId}'.`, "ToolError");
  }

  const parsed = await parseJobDefinition(jobDir);
  return {
    job_name: jobName,
    job_definition_yaml: jobDefinitionYaml,
    session_id: identity.sessionId,
    job_dir: parsed.job_dir,
    workflow_names: Object.keys(parsed.workflows),
  };
}

function sessionIdentity(params: JsonObject, options: { sessionId?: string; agentId?: string }): Required<Pick<SessionJobIdentity, "sessionId">> & { agentId?: string } {
  return {
    sessionId: requiredString(params.session_id ?? options.sessionId ?? "default", "session_id"),
    ...(stringOrUndefined(params.agent_id ?? options.agentId) ? { agentId: stringOrUndefined(params.agent_id ?? options.agentId) } : {}),
  };
}

function requiredJobName(value: JsonValue | undefined): string {
  const jobName = requiredString(value, "job_name");
  if (!JOB_NAME_PATTERN.test(jobName)) throw new WorkflowRuntimeError(`Invalid job_name '${jobName}': must match ^[a-z][a-z0-9_]*$`, "ToolError");
  return jobName;
}

function requiredJobDefinitionYaml(params: JsonObject): string {
  for (const key of ["job_definition_yaml", "job_yaml", "job_yml", "yaml"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  throw new WorkflowRuntimeError("job_definition_yaml is required", "ToolError");
}

function validateYamlSyntax(jobDefinitionYaml: string): void {
  try {
    parseYaml(jobDefinitionYaml);
  } catch (error) {
    if (error instanceof YAMLParseError || error instanceof Error) {
      throw new WorkflowRuntimeError(`Invalid YAML syntax: ${error.message}`, "ToolError");
    }
    throw new WorkflowRuntimeError(`Invalid YAML syntax: ${String(error)}`, "ToolError");
  }
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new WorkflowRuntimeError(`${name} is required`, "ToolError");
  return value;
}

function stringOrUndefined(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
