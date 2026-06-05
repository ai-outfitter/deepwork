import AjvModule, { type ValidateFunction } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { DeepSchema, DeepSchemaDiscoveryError } from "../types/deepschema.js";

const NAMED_SCHEMAS_DIR = ".deepwork/schemas";
const ANONYMOUS_PREFIX = ".deepschema.";
const ANONYMOUS_SUFFIX = ".yml";
const ENV_ADDITIONAL_SCHEMAS_FOLDERS = "DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS";
const ENV_STANDARD_SCHEMAS_DIR = "DEEPWORK_STANDARD_SCHEMAS_DIR";
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".eggs"]);
const SKIP_SUFFIXES = [".egg-info"];
const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(moduleDir, "deepschema_schema.json");
let compiledSchema: ValidateFunction | null = null;

export class DeepSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSchemaError";
  }
}

export async function discoverAllSchemas(projectRoot: string): Promise<{ schemas: DeepSchema[]; errors: DeepSchemaDiscoveryError[] }> {
  const root = resolve(projectRoot);
  const schemas: DeepSchema[] = [];
  const errors: DeepSchemaDiscoveryError[] = [];

  for (const manifest of await findNamedSchemas(root)) {
    try {
      schemas.push(await parseDeepSchemaFile(manifest, "named", basename(dirname(manifest))));
    } catch (error) {
      errors.push({ filePath: manifest, error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const manifest of await findAnonymousSchemas(root)) {
    try {
      schemas.push(await parseDeepSchemaFile(manifest, "anonymous", anonymousTargetFilename(basename(manifest))));
    } catch (error) {
      errors.push({ filePath: manifest, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { schemas, errors };
}

export async function findNamedSchemas(projectRoot: string): Promise<string[]> {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const folder of namedSchemaFolders(projectRoot)) {
    if (!existsSync(folder)) continue;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(entry.name)) continue;
      const manifest = join(folder, entry.name, "deepschema.yml");
      if (!existsSync(manifest)) continue;
      results.push(manifest);
      seen.add(entry.name);
    }
  }
  return results;
}

export async function findAnonymousSchemas(projectRoot: string): Promise<string[]> {
  const results = await walkForAnonymous(resolve(projectRoot));
  return results.sort();
}

export function anonymousTargetFilename(schemaFilename: string): string {
  return schemaFilename.slice(ANONYMOUS_PREFIX.length, -ANONYMOUS_SUFFIX.length);
}

export async function parseDeepSchemaFile(filepath: string, schemaType: "named" | "anonymous", name: string): Promise<DeepSchema> {
  let data: unknown;
  try {
    data = parseYaml(await readFile(filepath, "utf8"));
  } catch (error) {
    const message = error instanceof YAMLParseError || error instanceof Error ? error.message : String(error);
    throw new DeepSchemaError(`Failed to parse ${filepath}: ${message}`);
  }

  if (data === null || data === undefined) throw new DeepSchemaError(`File not found: ${filepath}`);
  if (!data) return emptySchema(name, schemaType, filepath);
  validateDeepSchemaData(data, filepath);
  const raw = data as Record<string, unknown>;
  return {
    name,
    schemaType,
    sourcePath: resolve(filepath),
    requirements: (raw.requirements as Record<string, string>) ?? {},
    parentDeepSchemas: (raw.parent_deep_schemas as string[]) ?? [],
    ...(raw.json_schema_path ? { jsonSchemaPath: String(raw.json_schema_path) } : {}),
    verificationBashCommand: (raw.verification_bash_command as string[]) ?? [],
    ...(raw.summary ? { summary: String(raw.summary) } : {}),
    ...(raw.instructions ? { instructions: String(raw.instructions) } : {}),
    examples: (raw.examples as Array<{ path: string; description: string }>) ?? [],
    references: (raw.references as Array<{ path: string; description: string }>) ?? [],
    matchers: (raw.matchers as string[]) ?? [],
  };
}

export function resolveAllSchemas(schemas: DeepSchema[]): { schemas: DeepSchema[]; errors: string[] } {
  const named = new Map(schemas.filter((schema) => schema.schemaType === "named").map((schema) => [schema.name, schema]));
  const resolved: DeepSchema[] = [];
  const errors: string[] = [];
  for (const schema of schemas) {
    try {
      resolved.push(resolveInheritance(schema, named));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { schemas: resolved, errors };
}

function resolveInheritance(schema: DeepSchema, named: Map<string, DeepSchema>, visited = new Set<string>()): DeepSchema {
  if (schema.parentDeepSchemas.length === 0) return schema;
  if (visited.has(schema.name)) throw new DeepSchemaError(`Circular parent reference detected: '${schema.name}' is in its own inheritance chain`);
  visited.add(schema.name);

  const requirements: Record<string, string> = {};
  const verificationBashCommand: string[] = [];
  let inheritedJsonSchemaPath: string | undefined;
  for (const parentName of schema.parentDeepSchemas) {
    const parent = named.get(parentName);
    if (!parent) throw new DeepSchemaError(`Schema '${schema.name}' references unknown parent '${parentName}'`);
    const resolvedParent = resolveInheritance(parent, named, new Set(visited));
    Object.assign(requirements, resolvedParent.requirements);
    verificationBashCommand.push(...resolvedParent.verificationBashCommand);
    inheritedJsonSchemaPath ??= resolvedParent.jsonSchemaPath;
  }
  Object.assign(requirements, schema.requirements);
  verificationBashCommand.push(...schema.verificationBashCommand);
  return { ...schema, requirements, verificationBashCommand, jsonSchemaPath: schema.jsonSchemaPath ?? inheritedJsonSchemaPath };
}

function namedSchemaFolders(projectRoot: string): string[] {
  const folders = [join(projectRoot, NAMED_SCHEMAS_DIR)];
  const standard = process.env[ENV_STANDARD_SCHEMAS_DIR] || standardSchemasDir();
  if (standard) folders.push(standard);
  const extra = process.env[ENV_ADDITIONAL_SCHEMAS_FOLDERS] ?? "";
  for (const entry of extra.split(":")) {
    const trimmed = entry.trim();
    if (trimmed) folders.push(trimmed);
  }
  return folders;
}

function standardSchemasDir(): string | null {
  const candidates = [
    resolve(moduleDir, "..", "..", "standard_schemas"),
    resolve(moduleDir, "..", "..", "..", "deep-work", "src", "deepwork", "standard_schemas"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function walkForAnonymous(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const results: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(root, entry.name);
    if (entry.isFile() && isAnonymousSchema(entry.name)) results.push(fullPath);
    else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      results.push(...await walkForAnonymous(fullPath));
    }
  }
  return results;
}

function isAnonymousSchema(filename: string): boolean {
  return filename.startsWith(ANONYMOUS_PREFIX) && filename.endsWith(ANONYMOUS_SUFFIX) && filename.length > ANONYMOUS_PREFIX.length + ANONYMOUS_SUFFIX.length;
}

function emptySchema(name: string, schemaType: "named" | "anonymous", filepath: string): DeepSchema {
  return { name, schemaType, sourcePath: resolve(filepath), requirements: {}, parentDeepSchemas: [], verificationBashCommand: [], examples: [], references: [], matchers: [] };
}

function validateDeepSchemaData(data: unknown, filepath: string): void {
  if (!compiledSchema) {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const AjvCtor = AjvModule as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: unknown): ValidateFunction };
    compiledSchema = new AjvCtor({ allErrors: true, strict: false }).compile(schema);
  }
  const validate = compiledSchema;
  if (!validate(data)) {
    const message = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") || "unknown validation error";
    throw new DeepSchemaError(`Schema validation failed for ${filepath}: ${message}`);
  }
}
