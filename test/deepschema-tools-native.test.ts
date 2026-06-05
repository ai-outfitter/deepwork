import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNamedSchemas } from "../src/bridge.js";

const tempDirs: string[] = [];
let previousStandardSchemasDir: string | undefined;
let previousAdditionalSchemasFolders: string | undefined;

beforeEach(async () => {
  previousStandardSchemasDir = process.env.DEEPWORK_STANDARD_SCHEMAS_DIR;
  previousAdditionalSchemasFolders = process.env.DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS;
  process.env.DEEPWORK_STANDARD_SCHEMAS_DIR = await makeTempDir("empty-standard-schemas");
  delete process.env.DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS;
});

afterEach(async () => {
  restoreEnv("DEEPWORK_STANDARD_SCHEMAS_DIR", previousStandardSchemasDir);
  restoreEnv("DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS", previousAdditionalSchemasFolders);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("native DeepSchema tools", () => {
  // Covers PI-REQ-002.10.1 through PI-REQ-002.10.4 and PI-REQ-002.11.1 by returning JSON-serializable named schema metadata without the Python bridge.
  it("lists project-local named schemas with name, summary, and matcher patterns", async () => {
    const project = await makeTempDir("project");
    await writeNamedSchema(project, "component", `summary: Component files
matchers:
  - "src/**/*.tsx"
requirements:
  named_exports: "Components MUST use named exports."
`);

    await expect(getNamedSchemas({ cwd: project })).resolves.toEqual([
      { name: "component", summary: "Component files", matchers: ["src/**/*.tsx"] },
    ]);
  });

  // Covers PI-REQ-002.10.2 and PI-REQ-001.13.3 by loading packaged standard schemas automatically when no environment override is provided.
  it("discovers packaged standard schemas automatically", async () => {
    const project = await makeTempDir("project");
    delete process.env.DEEPWORK_STANDARD_SCHEMAS_DIR;

    const result = await getNamedSchemas({ cwd: project }) as Array<{ name: string; summary: string; matchers: string[] }>;

    expect(result.map((schema) => schema.name)).toEqual(["deepreview", "deepschema", "job_yml", "requirements_file"]);
    expect(result.every((schema) => !schema.summary.startsWith("(failed to parse"))).toBe(true);
    expect(result.find((schema) => schema.name === "deepreview")?.matchers).toEqual(["**/.deepreview"]);
    expect(result.find((schema) => schema.name === "deepschema")?.matchers).toContain("**/.deepschema.*.yml");
  });

  // Covers PI-REQ-002.10.2 and PI-REQ-001.13.3 by preserving DeepSchema source precedence across project-local, standard, and environment-configured folders.
  it("discovers named schemas from project, standard, and additional folders with first-name precedence", async () => {
    const project = await makeTempDir("project");
    const standard = await makeTempDir("standard-schemas");
    const extra = await makeTempDir("extra-schemas");
    process.env.DEEPWORK_STANDARD_SCHEMAS_DIR = standard;
    process.env.DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS = extra;

    await writeNamedSchema(project, "dupe", "summary: Project wins\nmatchers: [\"project/**\"]\n");
    await writeSchemaInRoot(standard, "dupe", "summary: Standard loses\nmatchers: [\"standard/**\"]\n");
    await writeSchemaInRoot(standard, "standard_only", "summary: Standard only\nmatchers: [\"standard-only/**\"]\n");
    await writeSchemaInRoot(extra, "extra_only", "summary: Extra only\nmatchers: [\"extra/**\"]\n");

    await expect(getNamedSchemas({ cwd: project })).resolves.toEqual([
      { name: "dupe", summary: "Project wins", matchers: ["project/**"] },
      { name: "standard_only", summary: "Standard only", matchers: ["standard-only/**"] },
      { name: "extra_only", summary: "Extra only", matchers: ["extra/**"] },
    ]);
  });

  // Covers PI-REQ-001.12.1, PI-REQ-002.10.3, and PI-REQ-002.12.3 by preserving malformed schema diagnostics as structured list entries.
  it("returns a failed-parse placeholder for invalid named schemas", async () => {
    const project = await makeTempDir("project");
    await writeNamedSchema(project, "bad", "summary: 123\nmatchers: [\"src/**\"]\n");

    const result = await getNamedSchemas({ cwd: project }) as Array<{ name: string; summary: string; matchers: string[] }>;

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("bad");
    expect(result[0].summary).toContain("failed to parse");
    expect(result[0].summary).toContain("deepschema.yml");
    expect(result[0].matchers).toEqual([]);
  });
});

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `deepwork-pi-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeNamedSchema(projectRoot: string, name: string, content: string): Promise<void> {
  await writeSchemaInRoot(join(projectRoot, ".deepwork", "schemas"), name, content);
}

async function writeSchemaInRoot(root: string, name: string, content: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "deepschema.yml"), content);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
