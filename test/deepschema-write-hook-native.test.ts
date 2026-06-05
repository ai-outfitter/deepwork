import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDeepSchemaWriteHook } from "../src/bridge.js";

const tempDirs: string[] = [];
let previousStandardSchemasDir: string | undefined;
let previousAdditionalSchemasFolders: string | undefined;
let previousVerificationTimeout: string | undefined;

beforeEach(async () => {
  previousStandardSchemasDir = process.env.DEEPWORK_STANDARD_SCHEMAS_DIR;
  previousAdditionalSchemasFolders = process.env.DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS;
  previousVerificationTimeout = process.env.DEEPWORK_PI_DEEPSCHEMA_VERIFICATION_TIMEOUT_MS;
  process.env.DEEPWORK_STANDARD_SCHEMAS_DIR = await makeTempDir("empty-standard-schemas");
  delete process.env.DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS;
  delete process.env.DEEPWORK_PI_DEEPSCHEMA_VERIFICATION_TIMEOUT_MS;
});

afterEach(async () => {
  restoreEnv("DEEPWORK_STANDARD_SCHEMAS_DIR", previousStandardSchemasDir);
  restoreEnv("DEEPWORK_ADDITIONAL_SCHEMAS_FOLDERS", previousAdditionalSchemasFolders);
  restoreEnv("DEEPWORK_PI_DEEPSCHEMA_VERIFICATION_TIMEOUT_MS", previousVerificationTimeout);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("native DeepSchema write/edit hook", () => {
  // Covers PI-REQ-001.11.1 through PI-REQ-001.11.4, PI-REQ-001.13.3, and PI-REQ-002.10.2 by surfacing matching named-schema guidance through native Pi hook feedback.
  it("returns native guidance for files matching a named DeepSchema", async () => {
    const project = await makeProject();
    await writeNamedSchema(project, "component", `summary: Component files
instructions: Prefer named exports.
matchers:
  - "src/**/*.tsx"
requirements:
  no_default_export: "Components MUST NOT use default exports."
references:
  - path: guide.md
    description: Component guide
examples:
  - path: example.tsx
    description: Good component
`);
    await writeFile(join(project, "src", "App.tsx"), "export function App() { return null; }\n");

    const feedback = await runDeepSchemaWriteHook(project, "write", "src/App.tsx");

    expect(feedback).toContain("Note: this file must conform to the DeepSchema at .deepwork/schemas/component/deepschema.yml");
    expect(feedback).toContain("DeepSchema guidance for src/App.tsx");
    expect(feedback).toContain("Prefer named exports.");
    expect(feedback).toContain("Components MUST NOT use default exports.");
    expect(feedback).toContain("guide.md: Component guide");
    expect(feedback).toContain("example.tsx: Good component");
  });

  // Covers PI-REQ-001.11.2, PI-REQ-001.11.3, PI-REQ-001.11.5, and PI-REQ-001.12.4 by returning actionable native JSON Schema feedback without throwing.
  it("validates changed files against a matching schema's JSON Schema", async () => {
    const project = await makeProject();
    await writeNamedSchema(project, "config", `summary: Config files
matchers:
  - "config/**/*.json"
json_schema_path: schema.json
`);
    await writeFile(join(project, ".deepwork", "schemas", "config", "schema.json"), JSON.stringify({
      type: "object",
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    }));
    await writeFile(join(project, "config", "app.json"), JSON.stringify({ enabled: "yes" }));

    const feedback = await runDeepSchemaWriteHook(project, "edit", "config/app.json");

    expect(feedback).toContain("CRITICAL: DeepSchema validation failed");
    expect(feedback).toContain("JSON Schema validation failed");
    expect(feedback).toContain("/enabled must be boolean");
  });

  // Covers PI-REQ-001.11.1 through PI-REQ-001.11.5 and PI-REQ-002.10.2 by applying packaged standard schemas automatically to Pi DeepWork instances.
  it("applies packaged standard schemas without an environment override", async () => {
    const project = await makeProject();
    delete process.env.DEEPWORK_STANDARD_SCHEMAS_DIR;
    await writeFile(join(project, ".deepreview"), "{}\n");

    const feedback = await runDeepSchemaWriteHook(project, "write", ".deepreview");

    expect(feedback).toContain("standard_schemas/deepreview/deepschema.yml");
    expect(feedback).toContain("Schema for .deepreview config files");
    expect(feedback).not.toContain("JSON Schema file not found");
  });

  // Covers PI-REQ-001.11.2, PI-REQ-001.11.3, and PI-REQ-002.10.2 by matching anonymous schemas adjacent to the changed file.
  it("returns native guidance for anonymous DeepSchemas adjacent to the changed file", async () => {
    const project = await makeProject();
    await writeFile(join(project, "src", ".deepschema.settings.yml.yml"), `instructions: Keep settings minimal.
requirements:
  stable_keys: "Settings files MUST keep stable key names."
`);
    await writeFile(join(project, "src", "settings.yml"), "name: demo\n");

    const feedback = await runDeepSchemaWriteHook(project, "write", "src/settings.yml");

    expect(feedback).toContain(".deepschema.settings.yml.yml");
    expect(feedback).toContain("Keep settings minimal.");
    expect(feedback).toContain("Settings files MUST keep stable key names.");
  });

  // Covers PI-REQ-001.11.5 and PI-REQ-001.12.1 by degrading gracefully when an applicable anonymous DeepSchema cannot be parsed.
  it("reports applicable anonymous DeepSchema parse errors as feedback instead of throwing", async () => {
    const project = await makeProject();
    await writeFile(join(project, "src", ".deepschema.bad.json.yml"), "summary: 123\n");
    await writeFile(join(project, "src", "bad.json"), "{}\n");

    const feedback = await runDeepSchemaWriteHook(project, "write", "src/bad.json");

    expect(feedback).toContain("DeepSchema parse/resolve warning");
    expect(feedback).toContain(".deepschema.bad.json.yml");
    expect(feedback).toContain("Schema validation failed");
  });

  // Covers PI-REQ-001.11.2, PI-REQ-001.11.3, PI-REQ-001.12.3, and PI-REQ-001.12.4 by running native verification_bash_command checks with the changed file as $1.
  it("runs verification_bash_command and reports command failures", async () => {
    const project = await makeProject();
    await writeNamedSchema(project, "scripted", `matchers:
  - "src/**/*.txt"
verification_bash_command:
  - |
    test "$(cat $1)" = ok || { echo bad content; exit 7; }
`);
    await writeFile(join(project, "src", "data.txt"), "bad\n");

    const feedback = await runDeepSchemaWriteHook(project, "write", "src/data.txt");

    expect(feedback).toContain("CRITICAL: DeepSchema validation failed");
    expect(feedback).toContain("Command `test");
    expect(feedback).toContain("failed (exit 7): bad content");
  });

  // Covers PI-REQ-001.11.2, PI-REQ-001.11.5, and PI-REQ-001.12.3 by timing out long-running native verification_bash_command checks without throwing.
  it("times out long-running verification_bash_command checks", async () => {
    process.env.DEEPWORK_PI_DEEPSCHEMA_VERIFICATION_TIMEOUT_MS = "25";
    const project = await makeProject();
    await writeNamedSchema(project, "slow", `matchers:
  - "src/**/*.txt"
verification_bash_command:
  - "sleep 1"
`);
    await writeFile(join(project, "src", "slow.txt"), "ok\n");

    const feedback = await runDeepSchemaWriteHook(project, "edit", "src/slow.txt");

    expect(feedback).toContain("CRITICAL: DeepSchema validation failed");
    expect(feedback).toContain("Command `sleep 1` timed out after 1s");
  });

  // Covers PI-REQ-001.11.5 by returning no feedback and no error when no schema applies to the changed file.
  it("returns null when no DeepSchema applies", async () => {
    const project = await makeProject();
    await writeNamedSchema(project, "component", "matchers: [\"src/**/*.tsx\"]\n");
    await writeFile(join(project, "README.md"), "# demo\n");

    await expect(runDeepSchemaWriteHook(project, "write", "README.md")).resolves.toBeNull();
  });
});

async function makeProject(): Promise<string> {
  const project = await makeTempDir("project");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "config"), { recursive: true });
  return project;
}

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `deepwork-pi-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeNamedSchema(projectRoot: string, name: string, content: string): Promise<void> {
  const dir = join(projectRoot, ".deepwork", "schemas", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "deepschema.yml"), content);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
