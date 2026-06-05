import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { DeepSchemaDiscoveryError } from "../types/deepschema.js";
import type { ReferenceFile, ReviewRule } from "../types/reviews.js";
import { anonymousTargetFilename, discoverAllSchemas, resolveAllSchemas } from "./discovery.js";

export async function generateDeepSchemaReviewRules(projectRoot: string): Promise<{ rules: ReviewRule[]; errors: DeepSchemaDiscoveryError[] }> {
  const root = resolve(projectRoot);
  const discovered = await discoverAllSchemas(root);
  const resolved = resolveAllSchemas(discovered.schemas);
  const errors: DeepSchemaDiscoveryError[] = [
    ...discovered.errors,
    ...resolved.errors.map((error) => ({ filePath: root, error })),
  ];
  const rules: ReviewRule[] = [];

  for (const schema of resolved.schemas) {
    if (Object.keys(schema.requirements).length === 0) continue;
    const built = schema.schemaType === "named" ? namedSchemaRule(schema, root) : anonymousSchemaRule(schema, root);
    if (!built) continue;
    const refs = collectReferenceFiles(schema);
    errors.push(...refs.errors.map((error) => ({ filePath: schema.sourcePath, error })));
    built.referenceFiles = refs.referenceFiles;
    const examples = examplesSection(schema.examples);
    if (examples) built.instructions = `${built.instructions.trim()}\n\n${examples}`;
    rules.push(built);
  }

  return { rules, errors };
}

type SchemaLike = Awaited<ReturnType<typeof discoverAllSchemas>>["schemas"][number];

function namedSchemaRule(schema: SchemaLike, projectRoot: string): ReviewRule | null {
  if (schema.matchers.length === 0) return null;
  return {
    name: `${schema.name} DeepSchema Compliance`,
    description: `DeepSchema compliance review for ${schema.name}`,
    includePatterns: [...schema.matchers],
    excludePatterns: [],
    strategy: "individual",
    cadence: "change_cycle",
    cacheInvalidatesOn: "file_content",
    instructions: namedInstructions(schema),
    allChangedFilenames: false,
    unchangedMatchingFiles: false,
    sourceDir: projectRoot,
    sourceFile: schema.sourcePath,
    sourceLine: 0,
    referenceFiles: [],
  };
}

function anonymousSchemaRule(schema: SchemaLike, projectRoot: string): ReviewRule | null {
  const targetName = anonymousTargetFilename(schema.sourcePath.split(/[\\/]/).pop() ?? "");
  const targetPath = join(dirname(schema.sourcePath), targetName);
  const targetRel = relative(projectRoot, targetPath).split(/[\\/]/).join("/");
  if (targetRel.startsWith("..")) return null;
  return {
    name: `${targetName} DeepSchema Compliance`,
    description: `DeepSchema compliance review for ${targetName}`,
    includePatterns: [targetRel],
    excludePatterns: [],
    strategy: "individual",
    cadence: "change_cycle",
    cacheInvalidatesOn: "file_content",
    instructions: anonymousInstructions(schema),
    allChangedFilenames: false,
    unchangedMatchingFiles: false,
    sourceDir: projectRoot,
    sourceFile: schema.sourcePath,
    sourceLine: 0,
    referenceFiles: [],
  };
}

function namedInstructions(schema: SchemaLike): string {
  const parts = [`{file_path} is an instance of ${schema.name}.`];
  if (schema.summary) parts.push(`\n${schema.summary}`);
  if (schema.instructions) parts.push(`\n\nInstructions for dealing with these files:\n${schema.instructions}`);
  parts.push("\n\n", requirementsBody(schema.requirements));
  return parts.join("");
}

function anonymousInstructions(schema: SchemaLike): string {
  return [`{file_path} has requirements that it must follow.`, "\n\n", requirementsBody(schema.requirements)].join("");
}

function requirementsBody(requirements: Record<string, string>): string {
  const reqLines = Object.entries(requirements).map(([name, desc]) => `- **${name}**: ${desc}`).join("\n");
  return `Please review for compliance with the following requirements. You must fail reviews over anything that is MUST. You must fail reviews over any SHOULD that seems like it could be easily followed but is not. You should give feedback but not fail over anything else applicable. You can ignore N/A requirements.\n\n${reqLines}`;
}

function collectReferenceFiles(schema: SchemaLike): { referenceFiles: ReferenceFile[]; errors: string[] } {
  const schemaDir = dirname(schema.sourcePath);
  const referenceFiles: ReferenceFile[] = [];
  const errors: string[] = [];
  const add = (rawPath: string, description: string | undefined, sourceField: string) => {
    if (/^https?:\/\//.test(rawPath)) return;
    const resolved = resolve(schemaDir, rawPath);
    if (!existsSync(resolved)) {
      errors.push(`${schema.sourcePath}: ${sourceField} entry '${rawPath}' not found (resolved to ${resolved})`);
      return;
    }
    referenceFiles.push({ path: resolved, relativeLabel: rawPath, ...(description ? { description } : {}) });
  };
  for (const reference of schema.references) add(reference.path, reference.description, "references");
  if (schema.jsonSchemaPath) add(schema.jsonSchemaPath, `JSON Schema for ${schema.name}`, "json_schema_path");
  return { referenceFiles, errors };
}

function examplesSection(examples: Array<{ path: string; description: string }>): string {
  if (examples.length === 0) return "";
  const lines = ["Example files available for reference (read on demand):"];
  for (const example of examples) lines.push(example.description ? `- \`${example.path}\` — ${example.description}` : `- \`${example.path}\``);
  return lines.join("\n");
}
