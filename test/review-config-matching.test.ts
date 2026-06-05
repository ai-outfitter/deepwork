import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findDeepreviewFiles, loadAllReviewRules, parseDeepreviewFile } from "../src/reviews/config.js";
import { getChangedFiles } from "../src/reviews/git.js";
import { globMatch, matchFilesToRules, matchRule } from "../src/reviews/matching.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("native review config discovery and parsing", () => {
  // Covers PI-REQ-002.9.4, PI-REQ-002.9.11, PI-REQ-003.4.1, PI-REQ-003.4.2, and PI-REQ-003.4.4 by parsing .deepreview rules and resolving instruction file references relative to the rule source.
  it("discovers .deepreview files deepest first and parses rule fields", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), deepreviewYaml("root_rule", "*.md"));
    await mkdir(join(project, "src", "docs"), { recursive: true });
    await writeFile(join(project, "src", "docs", "instructions.md"), "Resolved instructions");
    await writeFile(join(project, "src", "docs", ".deepreview"), deepreviewYaml("nested_rule", "**/*.ts", { instructionFile: "instructions.md", agent: "reviewer" }));

    const files = await findDeepreviewFiles(project);
    const { rules, errors } = await loadAllReviewRules(project);

    expect(errors).toEqual([]);
    expect(files.map((file) => file.replace(project, "<PROJECT>"))).toEqual(["<PROJECT>/src/docs/.deepreview", "<PROJECT>/.deepreview"]);
    expect(rules.map((rule) => rule.name)).toEqual(["nested_rule", "root_rule"]);
    expect(rules[0].instructions).toBe("Resolved instructions");
    expect(rules[0].agent?.pi).toBe("reviewer");
    expect(rules[0].cadence).toBe("change_cycle");
    expect(rules[0].cacheInvalidatesOn).toBe("file_content");
    expect(rules[0].sourceLine).toBe(1);
  });

  // Covers PI-REQ-002.9.4 and PI-REQ-003.4.4 by parsing optional .deepreview lifecycle and cache settings.
  it("parses PR cadence and changed-file-set cache invalidation settings", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), deepreviewYaml("pr_rule", "**/*", { lifecycle: "pull_request", cacheInvalidatesOn: "changed_file_set" }));

    const [rule] = await parseDeepreviewFile(join(project, ".deepreview"));

    expect(rule.cadence).toBe("pull_request");
    expect(rule.cacheInvalidatesOn).toBe("changed_file_set");
  });

  // Covers PI-REQ-002.9.4 and PI-REQ-003.4.3 by returning structured discovery errors for invalid .deepreview files.
  it("reports invalid .deepreview files without hiding valid files", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), "bad_rule:\n  description: Missing match and review\n");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", ".deepreview"), deepreviewYaml("valid_rule", "*.ts"));

    const { rules, errors } = await loadAllReviewRules(project);

    expect(rules.map((rule) => rule.name)).toEqual(["valid_rule"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("Schema validation failed");
  });
});

describe("native review rule matching", () => {
  // Covers PI-REQ-002.9.10, PI-REQ-002.9.11, and PI-REQ-003.10.1 through PI-REQ-003.10.4 by matching explicit file filters with individual, matches_together, and all_changed_files strategies.
  it("matches explicit file filters with each DeepWork review strategy", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".deepreview"), [
      deepreviewYaml("individual_rule", "src/**/*.ts", { strategy: "individual" }),
      deepreviewYaml("together_rule", "src/**/*.ts", { strategy: "matches_together" }),
      deepreviewYaml("all_rule", "src/**/*.ts", { strategy: "all_changed_files", allChanged: true }),
    ].join("\n"));
    const { rules } = await loadAllReviewRules(project);

    const tasks = matchFilesToRules(["src/a.ts", "src/nested/b.ts", "README.md"], rules, project, "pi");

    expect(tasks.map((task) => ({ rule: task.ruleName, files: task.filesToReview, all: task.allChangedFilenames }))).toEqual([
      { rule: "individual_rule", files: ["src/a.ts"], all: undefined },
      { rule: "individual_rule", files: ["src/nested/b.ts"], all: undefined },
      { rule: "together_rule", files: ["src/a.ts", "src/nested/b.ts"], all: undefined },
      { rule: "all_rule", files: ["src/a.ts", "src/nested/b.ts", "README.md"], all: ["src/a.ts", "src/nested/b.ts", "README.md"] },
    ]);
  });

  // Covers PI-REQ-001.13.2 and PI-REQ-002.9.4 by preserving DeepWork glob semantics for include/exclude patterns relative to the .deepreview source directory.
  it("matches include and exclude globs relative to each .deepreview file", async () => {
    const project = await makeProject();
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", ".deepreview"), deepreviewYaml("src_rule", "**/*.ts", { exclude: ["generated/**"] }));
    const [rule] = await parseDeepreviewFile(join(project, "src", ".deepreview"));

    expect(globMatch("nested/file.ts", "**/*.ts")).toBe(true);
    expect(matchRule(["src/app.ts", "src/generated/app.ts", "other/app.ts"], rule, project)).toEqual(["src/app.ts"]);
  });

  // Covers PI-REQ-002.9.7 by detecting unstaged, staged, and untracked files through native git changed-file detection.
  it("detects changed files from git working tree state", async () => {
    const project = await makeProject();
    await git(project, "init");
    await git(project, "config", "user.email", "test@example.com");
    await git(project, "config", "user.name", "Test User");
    await writeFile(join(project, "tracked.txt"), "base\n");
    await git(project, "add", "tracked.txt");
    await git(project, "commit", "-m", "base");
    await writeFile(join(project, "tracked.txt"), "changed\n");
    await writeFile(join(project, "staged.txt"), "staged\n");
    await git(project, "add", "staged.txt");
    await writeFile(join(project, "untracked.txt"), "untracked\n");

    const changed = await getChangedFiles(project, "HEAD");

    expect(changed).toEqual(["staged.txt", "tracked.txt", "untracked.txt"]);
  });
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deepwork-pi-review-"));
  tempDirs.push(dir);
  return dir;
}

function deepreviewYaml(name: string, include: string, options: { strategy?: string; exclude?: string[]; instructionFile?: string; agent?: string; allChanged?: boolean; lifecycle?: string; cacheInvalidatesOn?: string } = {}): string {
  const instructions = options.instructionFile ? `
      file: ${options.instructionFile}` : " Check carefully.";
  const agent = options.agent ? `
    agent:
      pi: ${options.agent}` : "";
  const additional = options.allChanged ? `
    additional_context:
      all_changed_filenames: true` : "";
  const exclude = options.exclude ? `
    exclude:
${options.exclude.map((item) => `      - "${item}"`).join("\n")}` : "";
  const lifecycle = options.lifecycle ? `
  lifecycle:
    cadence: ${options.lifecycle}` : "";
  const cache = options.cacheInvalidatesOn ? `
    cache:
      invalidates_on: ${options.cacheInvalidatesOn}` : "";
  return `${name}:
  description: ${name} description${lifecycle}
  match:
    include:
      - "${include}"${exclude}
  review:
    strategy: ${options.strategy ?? "individual"}${cache}${agent}${additional}
    instructions:${instructions}
`;
}

function git(cwd: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`)));
  });
}
