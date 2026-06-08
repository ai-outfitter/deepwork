import AjvModule, { type ValidateFunction } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { DiscoveryError, ReferenceFile, ReviewCacheInvalidation, ReviewCadence, ReviewRule, ReviewStrategy } from "../types/reviews.js";

const DEEPREVIEW_FILENAME = ".deepreview";
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".eggs"]);
const SKIP_SUFFIXES = [".egg-info"];
const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(moduleDir, "deepreview_schema.json");
let compiledSchema: ValidateFunction | null = null;

export class ReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewConfigError";
  }
}

export async function findDeepreviewFiles(projectRoot: string): Promise<string[]> {
  const root = resolve(projectRoot);
  const files = await walkForDeepreview(root);
  const rootDepth = root.split(/[\\/]+/).length;
  return files.sort((a, b) => {
    const depthA = a.split(/[\\/]+/).length;
    const depthB = b.split(/[\\/]+/).length;
    return depthB - rootDepth - (depthA - rootDepth) || a.localeCompare(b);
  });
}

export async function loadAllReviewRules(projectRoot: string): Promise<{ rules: ReviewRule[]; errors: DiscoveryError[] }> {
  const rules: ReviewRule[] = [];
  const errors: DiscoveryError[] = [];
  for (const file of await findDeepreviewFiles(projectRoot)) {
    try {
      rules.push(...await parseDeepreviewFile(file));
    } catch (error) {
      errors.push({ filePath: file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { rules, errors };
}

export async function parseDeepreviewFile(filepath: string): Promise<ReviewRule[]> {
  let data: unknown;
  try {
    data = parseYaml(await readFile(filepath, "utf8"));
  } catch (error) {
    const message = error instanceof YAMLParseError || error instanceof Error ? error.message : String(error);
    throw new ReviewConfigError(`Failed to parse ${filepath}: ${message}`);
  }

  if (data === null || data === undefined) throw new ReviewConfigError(`File not found: ${filepath}`);
  if (!data) return [];
  validateDeepreviewData(data, filepath);

  const raw = data as Record<string, any>;
  const sourceDir = dirname(resolve(filepath));
  const lineNumbers = findRuleLineNumbers(readFileSync(filepath, "utf8"));
  const rules: ReviewRule[] = [];
  for (const [name, ruleData] of Object.entries(raw)) {
    rules.push(await parseRule(name, ruleData, sourceDir, resolve(filepath), lineNumbers.get(name) ?? 1));
  }
  return rules;
}

async function parseRule(name: string, data: any, sourceDir: string, sourceFile: string, sourceLine: number): Promise<ReviewRule> {
  const review = data.review;
  const lifecycle = data.lifecycle ?? {};
  const cache = review.cache ?? {};
  const additionalContext = review.additional_context ?? {};
  const precomputed = review.precomputed_info_for_reviewer_bash_command;
  return {
    name,
    description: data.description,
    includePatterns: data.match.include,
    excludePatterns: data.match.exclude ?? [],
    strategy: review.strategy as ReviewStrategy,
    cadence: (lifecycle.cadence ?? "change_cycle") as ReviewCadence,
    cacheInvalidatesOn: (cache.invalidates_on ?? "file_content") as ReviewCacheInvalidation,
    instructions: await resolveInstructions(review.instructions, sourceDir),
    ...(review.agent ? { agent: review.agent as Record<string, string> } : {}),
    allChangedFilenames: additionalContext.all_changed_filenames ?? false,
    unchangedMatchingFiles: additionalContext.unchanged_matching_files ?? false,
    ...(precomputed ? { precomputedInfoBashCommand: resolve(sourceDir, precomputed) } : {}),
    ...(review.review_depth ? { reviewDepth: review.review_depth as "lightweight" } : {}),
    sourceDir,
    sourceFile,
    sourceLine,
    referenceFiles: parseReferenceFiles(review.reference_files ?? [], sourceDir),
  };
}

async function resolveInstructions(instructions: string | { file: string }, sourceDir: string): Promise<string> {
  if (typeof instructions === "string") return instructions;
  const filePath = join(sourceDir, instructions.file);
  if (!existsSync(filePath)) throw new ReviewConfigError(`Instructions file not found: ${filePath}`);
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new ReviewConfigError(`Failed to read instructions file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseReferenceFiles(entries: Array<{ path: string; description?: string }>, sourceDir: string): ReferenceFile[] {
  return entries.map((entry) => ({
    path: resolve(sourceDir, entry.path),
    relativeLabel: entry.path,
    ...(entry.description ? { description: entry.description } : {}),
  }));
}

async function walkForDeepreview(root: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(root, entry.name);
    if (entry.isFile() && entry.name === DEEPREVIEW_FILENAME) results.push(fullPath);
    else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      results.push(...await walkForDeepreview(fullPath));
    }
  }
  return results;
}

function validateDeepreviewData(data: unknown, filepath: string): void {
  if (!compiledSchema) {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const AjvCtor = AjvModule as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: unknown): ValidateFunction };
    compiledSchema = new AjvCtor({ allErrors: true, strict: false }).compile(schema);
  }
  const validate = compiledSchema;
  if (!validate(data)) {
    const message = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") || "unknown validation error";
    throw new ReviewConfigError(`Schema validation failed for ${filepath}: ${message}`);
  }
}

function findRuleLineNumbers(source: string): Map<string, number> {
  const lines = source.split(/\r?\n/);
  const result = new Map<string, number>();
  lines.forEach((line, index) => {
    const match = /^([a-zA-Z0-9_-]+)\s*:/.exec(line);
    if (match) result.set(match[1], index + 1);
  });
  return result;
}

export function formatSourceLocation(rule: ReviewRule, projectRoot: string): string {
  const rel = relative(projectRoot, rule.sourceFile);
  return `${rel && !rel.startsWith("..") ? rel : rule.sourceFile}:${rule.sourceLine}`;
}
