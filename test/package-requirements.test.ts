import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import deepworkPi from "../src/index.js";

const root = process.cwd();
const requiredToolNames = [
  "deepwork_get_workflows",
  "deepwork_register_session_job",
  "deepwork_get_session_job",
  "deepwork_start_workflow",
  "deepwork_finished_step",
  "deepwork_abort_workflow",
  "deepwork_go_to_step",
  "deepwork_get_review_instructions",
  "deepwork_get_configured_reviews",
  "deepwork_mark_review_as_passed",
  "deepwork_get_named_schemas",
];
const requiredSkillNames = ["deepwork", "review", "configure-reviews", "deepreviews", "deepschema", "deepplan", "new-user", "record"];

describe("Pi package requirements", () => {
  // Covers PI-REQ-001.1.1 through PI-REQ-001.1.7.
  it("declares the required native Pi package layout and manifest fields", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(pkg.name).toBe("deepwork");
    expect(pkg.description).toEqual(expect.any(String));
    expect(pkg.version).toEqual(expect.any(String));
    expect(pkg.license).toEqual(expect.any(String));
    expect(pkg.repository).toEqual(expect.any(Object));
    expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
    expect(pkg.pi.skills).toEqual(["./skills"]);
    expect(pkg.pi.prompts).toEqual(["./prompts"]);
    expect(pkg.dependencies).toMatchObject({ ajv: expect.any(String), yaml: expect.any(String) });
    expect(pkg.scripts).toMatchObject({ check: expect.stringContaining("check:package"), coverage: expect.stringContaining("--coverage") });
  });

  // Covers PI-REQ-001.1.8 and PI-REQ-001.1.9.
  it("declares standalone validation and coverage scripts", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const vitestConfig = await readFile(join(root, "vitest.config.ts"), "utf8");

    expect(packageJson.scripts.check).toContain("npm run check:package");
    expect(packageJson.scripts.check).toContain("npm run typecheck");
    expect(packageJson.scripts.check).toContain("npm run test");
    expect(packageJson.scripts.coverage).toContain("--coverage");
    expect(vitestConfig).toContain("statements: 100");
    expect(vitestConfig).toContain("branches: 100");
    expect(vitestConfig).toContain("functions: 100");
    expect(vitestConfig).toContain("lines: 100");
  });

  // Covers PI-REQ-001.2.1 through PI-REQ-001.2.7 and PI-REQ-002.2.1 through PI-REQ-002.2.7.
  it("provides a native extension entry point and centralized bridge without MCP configuration", async () => {
    expect(existsSync(join(root, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(root, "src", "bridge.ts"))).toBe(true);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);

    const entry = await readFile(join(root, "src", "index.ts"), "utf8");
    const extension = await readFile(join(root, "extensions", "index.ts"), "utf8");
    const bridge = await readFile(join(root, "src", "bridge.ts"), "utf8");

    expect(entry).toContain("export { default }");
    expect(extension).toContain("pi.registerTool");
    expect(extension).not.toContain("registerMcp");
    expect(extension).not.toContain("mcp__");
    expect(bridge).toContain("export async function getWorkflows");
    expect(bridge).toContain("export async function startWorkflow");
    expect(bridge).toContain("export async function registerSessionJob");
    expect(bridge).toContain("export async function getSessionJob");
  });

  // Covers PI-REQ-002.1.1 through PI-REQ-002.1.3, PI-REQ-002.3.1, PI-REQ-002.4.1, PI-REQ-002.5.1, PI-REQ-002.7.1, PI-REQ-002.8.1, PI-REQ-002.9.1 through PI-REQ-002.9.3, PI-REQ-002.10.1, PI-REQ-002.13.1, and PI-REQ-002.14.1 through PI-REQ-002.14.2.
  it("registers the complete native deepwork_ tool surface through pi.registerTool", () => {
    const registered = collectExtensionRegistrations();

    expect(registered.tools).toEqual(requiredToolNames);
    expect(registered.tools.every((name) => name.startsWith("deepwork_"))).toBe(true);
  });

  // Covers PI-REQ-001.3.1, PI-REQ-001.4.1, PI-REQ-001.4.2, PI-REQ-001.5.2, and PI-REQ-001.6.1.
  it("keeps DeepWork workflow dispatch in prompt/skill resources and only registers non-skill compatibility commands", () => {
    const registered = collectExtensionRegistrations();

    expect(registered.commands).toEqual(["review", "deepwork_review", "configure-reviews", "record"]);
    expect(registered.commands).not.toContain("deepwork");
  });

  // Covers PI-REQ-001.8.1, PI-REQ-001.8.3 through PI-REQ-001.8.5, PI-REQ-001.10.1, PI-REQ-001.10.6, and PI-REQ-001.11.1 through PI-REQ-001.11.5.
  it("registers lifecycle hooks for context restoration, commit review reminders, and DeepSchema write feedback", () => {
    const registered = collectExtensionRegistrations();

    expect(registered.events).toEqual(["session_shutdown", "session_start", "before_agent_start", "tool_result"]);
  });

  // Covers PI-REQ-001.6.1 through PI-REQ-001.6.6.
  it("ships all required skills with valid Pi skill frontmatter", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(packageJson.pi.skills).toEqual(["./skills"]);

    for (const skillName of requiredSkillNames) {
      const skillPath = join(root, "skills", skillName, "SKILL.md");
      expect(existsSync(skillPath), `${skillName} SKILL.md should exist`).toBe(true);
      expect(skillName).toMatch(/^[a-z0-9-]+$/);

      const source = await readFile(skillPath, "utf8");
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatter, `${skillName} should have YAML frontmatter`).not.toBeNull();
      const metadata = parseYaml(frontmatter?.[1] ?? "") as { name?: string; description?: string };
      expect(metadata.name).toBe(skillName);
      expect(metadata.description).toEqual(expect.any(String));
      expect(metadata.description?.length).toBeGreaterThan(0);
    }
  });

  // Covers PI-REQ-001.6.1 through PI-REQ-001.6.7.
  it("ships a /deepwork prompt template that invokes the plain skill-style DeepWork instructions", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(packageJson.pi.prompts).toEqual(["./prompts"]);

    const promptPath = join(root, "prompts", "deepwork.md");
    expect(existsSync(promptPath)).toBe(true);
    const source = await readFile(promptPath, "utf8");
    expect(source).toContain("description: Start, inspect, or create DeepWork workflows");
    expect(source).toContain("User request: $ARGUMENTS");
    expect(source).toContain("deepwork_get_workflows");
    expect(source).toContain("deepwork_start_workflow");
  });

  // Covers PI-REQ-001.7.6 and PI-REQ-003.9.6.
  it("ships DeepWork native review example prompt files referenced by bundled workflows", async () => {
    const examplePaths = [
      "plugins/claude/example_reviews/prompt_best_practices.md",
      "plugins/claude/example_reviews/suggest_new_reviews.md",
    ];

    for (const relativePath of examplePaths) {
      const path = join(root, relativePath);
      expect(existsSync(path), `${relativePath} should exist`).toBe(true);
      const source = await readFile(path, "utf8");
      expect(source.trim().length, `${relativePath} should not be empty`).toBeGreaterThan(0);
      expect(source, relativePath).not.toContain("mcp__");
    }

    const reviewsJob = await readFile(join(root, "standard_jobs", "deepwork_reviews", "job.yml"), "utf8");
    for (const relativePath of examplePaths) {
      expect(reviewsJob).toContain(relativePath);
    }
  });

  // Covers PI-REQ-001.6.7, PI-REQ-001.7.5, PI-REQ-002.13.4, PI-REQ-003.9.5, and PI-REQ-003.11.5.
  it("keeps user-facing docs, skills, and dispatch prompts on native Pi tool names rather than MCP tool names", async () => {
    const userFacingPaths = [
      "README.md",
      "docs/native-bridge.md",
      "docs/README_REVIEWS.md",
      "extensions/index.ts",
      ...requiredSkillNames.map((name) => `skills/${name}/SKILL.md`),
      "prompts/deepwork.md",
    ];

    for (const relativePath of userFacingPaths) {
      const source = await readFile(join(root, relativePath), "utf8");
      expect(source, relativePath).not.toContain("mcp__");
      expect(source, relativePath).not.toMatch(/mcp__[A-Za-z0-9_]*__/);
    }
  });

  // Covers PI-REQ-001.7.1, PI-REQ-001.7.3, PI-REQ-001.7.4, and PI-REQ-001.7.5.
  it("includes review reference and setup documentation for native Pi usage", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const reviews = await readFile(join(root, "docs", "README_REVIEWS.md"), "utf8");

    expect(readme).toContain("native Pi");
    expect(readme).toContain("does **not** require `.mcp.json`");
    expect(reviews).toContain(".deepreview");
    expect(reviews.toLowerCase()).toContain("review strategies");
    expect(reviews.toLowerCase()).toContain("changed-file");
    expect(reviews).toContain("DeepSchema");
    expect(reviews.toLowerCase()).toContain("quality gates");
    expect(reviews.toLowerCase()).toContain("pass caching");
  });

  // Covers PI-REQ-003.12.1 through PI-REQ-003.12.4.
  it("keeps requirement files in RFC 2119-style numbered form", async () => {
    const requirementFiles = [
      "doc/specs/deepwork-pi/PI-REQ-001-native-pi-extension.md",
      "doc/specs/deepwork-pi/PI-REQ-002-native-pi-tools.md",
      "doc/specs/deepwork-pi/PI-REQ-003-native-pi-reviews.md",
    ];
    const normative = /\b(MUST|MUST NOT|SHOULD|SHOULD NOT|MAY|SHALL)\b/;

    for (const relativePath of requirementFiles) {
      const source = await readFile(join(root, relativePath), "utf8");
      const numbered = source.split("\n").filter((line) => /^\d+\. /.test(line));
      expect(numbered.length, `${relativePath} should contain numbered requirements`).toBeGreaterThan(0);
      expect(numbered.every((line) => normative.test(line)), relativePath).toBe(true);
    }
  });
});

function collectExtensionRegistrations(): { tools: string[]; commands: string[]; events: string[] } {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on(name: string) {
      events.push(name);
    },
  };

  deepworkPi(pi as never);
  return { tools, commands, events };
}
