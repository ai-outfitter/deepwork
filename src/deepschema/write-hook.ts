import AjvModule, { type ValidateFunction } from "ajv";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { DeepSchema, DeepSchemaDiscoveryError } from "../types/deepschema.js";
import { discoverAllSchemas, resolveAllSchemas, anonymousTargetFilename } from "./discovery.js";
import { globMatch } from "../reviews/matching.js";

export async function runDeepSchemaWriteHookNative(projectRoot: string, _toolName: string, filePath: string): Promise<string | null> {
  const root = resolve(projectRoot);
  const relativePath = projectRelativePath(root, filePath);
  if (!relativePath) return null;

  const discovered = await discoverAllSchemas(root);
  const resolved = resolveAllSchemas(discovered.schemas);
  const schemas = resolved.schemas.filter((schema) => schemaAppliesToFile(schema, relativePath, root));
  const relevantErrors = relevantDiscoveryErrors(discovered.errors, relativePath, root);

  if (schemas.length === 0 && relevantErrors.length === 0) return null;

  const notes = schemas.map((schema) => `Note: this file must conform to the DeepSchema at ${relativeToRoot(root, schema.sourcePath)}`);
  const guidance = schemas.flatMap((schema) => formatGuidance(schema, root));
  const validationErrors: string[] = [];

  for (const schema of schemas) {
    if (schema.jsonSchemaPath) {
      const error = await validateJsonSchema(join(dirname(schema.sourcePath), schema.jsonSchemaPath), join(root, relativePath));
      if (error) validationErrors.push(`${relativeToRoot(root, schema.sourcePath)}: ${error}`);
    }

    for (const command of schema.verificationBashCommand) {
      const error = await runVerificationCommand(command, join(root, relativePath), root);
      if (error) validationErrors.push(`${relativeToRoot(root, schema.sourcePath)}: ${error}`);
    }
  }

  for (const error of [...relevantErrors, ...resolved.errors.map((message) => ({ filePath: root, error: message }))]) {
    validationErrors.push(`DeepSchema parse/resolve warning: ${relativeToRoot(root, error.filePath)}: ${error.error}`);
  }

  const parts: string[] = [];
  if (notes.length > 0) parts.push(notes.join("\n"));
  if (guidance.length > 0) parts.push([`DeepSchema guidance for ${relativePath}:`, ...guidance].join("\n"));
  if (validationErrors.length > 0) {
    parts.push(`CRITICAL: DeepSchema validation failed when it tried to verify this change.\n\n${validationErrors.join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function schemaAppliesToFile(schema: DeepSchema, relativePath: string, projectRoot: string): boolean {
  if (schema.schemaType === "named") return schema.matchers.some((pattern) => globMatch(relativePath, pattern));

  const target = join(dirname(schema.sourcePath), anonymousTargetFilename(schema.sourcePath.split(/[\\/]/).pop() ?? ""));
  return normalizePath(relative(projectRoot, target)) === relativePath;
}

function formatGuidance(schema: DeepSchema, projectRoot: string): string[] {
  const lines = [`- Schema: ${schema.name} (${relativeToRoot(projectRoot, schema.sourcePath)})`];
  if (schema.summary) lines.push(`  Summary: ${schema.summary}`);
  if (schema.instructions) lines.push(`  Instructions: ${schema.instructions}`);
  const requirementEntries = Object.entries(schema.requirements);
  if (requirementEntries.length > 0) {
    lines.push("  Requirements:");
    for (const [name, requirement] of requirementEntries) lines.push(`  - ${name}: ${requirement}`);
  }
  if (schema.references.length > 0) {
    lines.push("  References:");
    for (const ref of schema.references) lines.push(`  - ${ref.path}: ${ref.description}`);
  }
  if (schema.examples.length > 0) {
    lines.push("  Examples:");
    for (const example of schema.examples) lines.push(`  - ${example.path}: ${example.description}`);
  }
  if (schema.verificationBashCommand.length > 0) {
    lines.push("  Verification commands:");
    for (const command of schema.verificationBashCommand) lines.push(`  - ${command}`);
  }
  return lines;
}

async function validateJsonSchema(schemaPath: string, targetPath: string): Promise<string | null> {
  if (!existsSync(schemaPath)) return `JSON Schema file not found: ${schemaPath}`;
  if (!existsSync(targetPath)) return `File not found: ${targetPath}`;

  let document: unknown;
  let schema: unknown;
  try {
    document = parseYaml(await readFile(targetPath, "utf8"));
  } catch (error) {
    return `Cannot parse file: ${formatYamlOrError(error)}`;
  }

  try {
    schema = parseYaml(await readFile(schemaPath, "utf8"));
  } catch (error) {
    return `Cannot read JSON Schema: ${formatYamlOrError(error)}`;
  }

  if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
    return `Cannot read JSON Schema: not a JSON Schema object (got ${Array.isArray(schema) ? "array" : typeof schema})`;
  }

  try {
    const AjvCtor = AjvModule as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: unknown): ValidateFunction };
    const validate = new AjvCtor({ allErrors: true, strict: false }).compile(schema);
    if (!validate(document)) {
      const message = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") || "unknown validation error";
      return `JSON Schema validation failed: ${message}`;
    }
  } catch (error) {
    return `Cannot read JSON Schema: ${error instanceof Error ? error.message : String(error)}`;
  }

  return null;
}

async function runVerificationCommand(command: string, filePath: string, projectRoot: string): Promise<string | null> {
  const timeoutMs = verificationTimeoutMs();
  return new Promise((resolveCommand) => {
    const child = spawn("bash", ["-c", command, "--", filePath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolveCommand(`Command \`${command}\` timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand(`Failed to run command \`${command}\`: ${error.message}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolveCommand(null);
        return;
      }
      const output = `${stdout}${stderr}`.trim();
      resolveCommand(`Command \`${command}\` failed (exit ${code ?? "unknown"}): ${output}`);
    });
  });
}

function verificationTimeoutMs(): number {
  const configured = Number(process.env.DEEPWORK_PI_DEEPSCHEMA_VERIFICATION_TIMEOUT_MS ?? "");
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}

function relevantDiscoveryErrors(errors: DeepSchemaDiscoveryError[], relativePath: string, projectRoot: string): DeepSchemaDiscoveryError[] {
  const anonymousSchemaPath = join(projectRoot, dirname(relativePath), `.deepschema.${relativePath.split("/").pop()}.yml`);
  return errors.filter((error) => resolve(error.filePath) === resolve(anonymousSchemaPath));
}

function projectRelativePath(projectRoot: string, filePath: string): string | null {
  const absolute = resolve(projectRoot, filePath);
  const relativePath = normalizePath(relative(projectRoot, absolute));
  if (!relativePath || relativePath.startsWith("..") || relativePath === ".") return null;
  return relativePath;
}

function relativeToRoot(projectRoot: string, path: string): string {
  const rel = normalizePath(relative(projectRoot, path));
  return rel.startsWith("..") ? path : rel;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function formatYamlOrError(error: unknown): string {
  return error instanceof YAMLParseError || error instanceof Error ? error.message : String(error);
}
