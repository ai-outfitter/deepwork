import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkflows } from "../src/bridge.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(testDir, "fixtures", "projects");
const goldenRoot = join(testDir, "golden", "get-workflows");
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("native getWorkflows", () => {
  // Covers PI-REQ-001.13.1, PI-REQ-001.13.4, PI-REQ-002.3.3 through PI-REQ-002.3.7, PI-REQ-002.11.1, and PI-REQ-002.13.4.
  it("matches the fruits workflow golden without invoking Python", async () => {
    await expectNativeGolden("fruits");
  });

  // Covers PI-REQ-002.3.8, PI-REQ-002.3.9, and PI-REQ-002.12.1 through PI-REQ-002.12.5.
  it("reports invalid jobs in errors and issue_detected", async () => {
    await expectNativeGolden("invalid");
  });

  // Covers PI-REQ-002.3.3, PI-REQ-002.3.8, PI-REQ-002.12.2, PI-REQ-002.12.5, and PI-REQ-002.12.6.
  it("returns valid jobs and invalid-job diagnostics together", async () => {
    await expectNativeGolden("mixed");
  });
});

async function expectNativeGolden(name: string): Promise<void> {
  const projectRoot = await copyFixtureProject(name);
  const standardJobsDir = await mkdtemp(join(tmpdir(), "deepwork-pi-empty-standard-"));
  tempDirs.push(standardJobsDir);

  const previousStandardJobsDir = process.env.DEEPWORK_STANDARD_JOBS_DIR;
  process.env.DEEPWORK_STANDARD_JOBS_DIR = standardJobsDir;
  try {
    const result = await getWorkflows({ cwd: projectRoot });
    const sanitized = sanitize(result, projectRoot);
    const goldenPath = join(goldenRoot, `${name}.native.json`);

    if (process.env.UPDATE_GOLDEN) {
      await writeFile(goldenPath, `${JSON.stringify(sanitized, null, 2)}\n`);
    }

    const expected = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(sanitized).toEqual(expected);
    expect(JSON.stringify(sanitized)).not.toContain("mcp__");
  } finally {
    if (previousStandardJobsDir === undefined) {
      delete process.env.DEEPWORK_STANDARD_JOBS_DIR;
    } else {
      process.env.DEEPWORK_STANDARD_JOBS_DIR = previousStandardJobsDir;
    }
  }
}

async function copyFixtureProject(name: string): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), `deepwork-pi-${name}-`));
  tempDirs.push(projectRoot);
  await mkdir(projectRoot, { recursive: true });
  await copyDirectory(join(fixtureRoot, name), projectRoot);
  return projectRoot;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const { cp } = await import("node:fs/promises");
  await cp(source, destination, { recursive: true });
}

function sanitize(value: unknown, projectRoot: string): unknown {
  if (typeof value === "string") return value.replaceAll(projectRoot, "<PROJECT>");
  if (Array.isArray(value)) return value.map((item) => sanitize(item, projectRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, projectRoot)]));
  }
  return value;
}
