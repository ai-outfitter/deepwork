import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ReferenceFile, ReviewRule, ReviewTaskNative } from "../types/reviews.js";
import { formatSourceLocation } from "./config.js";

export function matchFilesToRules(changedFiles: string[], rules: ReviewRule[], projectRoot: string, platform = "pi"): ReviewTaskNative[] {
  const tasks: ReviewTaskNative[] = [];
  const root = resolve(projectRoot);
  for (const rule of rules) {
    const matched = matchRule(changedFiles, rule, root);
    if (matched.length === 0) continue;

    const agentName = rule.agent?.[platform];
    const sourceLocation = formatSourceLocation(rule, root);
    const allChangedFilenames = rule.allChangedFilenames ? [...changedFiles] : undefined;
    const base = {
      instructions: rule.instructions,
      ...(agentName ? { agentName } : {}),
      sourceLocation,
      additionalFiles: [] as string[],
      ...(allChangedFilenames ? { allChangedFilenames } : {}),
      ...(rule.precomputedInfoBashCommand ? { precomputedInfoBashCommand: rule.precomputedInfoBashCommand } : {}),
      cacheInvalidatesOn: rule.cacheInvalidatesOn,
    };

    if (rule.strategy === "individual") {
      for (const filepath of matched) {
        const fileRef: ReferenceFile = { path: resolve(root, filepath), relativeLabel: filepath, description: "File under review" };
        tasks.push({
          ruleName: rule.name,
          filesToReview: [filepath],
          referenceFiles: [fileRef, ...rule.referenceFiles],
          ...base,
        });
      }
    } else if (rule.strategy === "matches_together") {
      tasks.push({
        ruleName: rule.name,
        filesToReview: matched,
        referenceFiles: rule.referenceFiles,
        ...base,
        additionalFiles: [],
      });
    } else if (rule.strategy === "all_changed_files") {
      tasks.push({
        ruleName: rule.name,
        filesToReview: [...changedFiles],
        referenceFiles: rule.referenceFiles,
        ...base,
      });
    }
  }
  return tasks;
}

export function matchRule(changedFiles: string[], rule: ReviewRule, projectRoot: string): string[] {
  let sourceRel: string;
  try {
    sourceRel = normalizePath(relative(projectRoot, rule.sourceDir));
  } catch {
    return [];
  }
  if (sourceRel.startsWith("..")) return [];

  const matched: string[] = [];
  for (const filepath of changedFiles) {
    const normalized = normalizePath(filepath);
    const relToSource = relativeToDir(normalized, sourceRel);
    if (relToSource === null) continue;
    if (!rule.includePatterns.some((pattern) => globMatch(relToSource, pattern))) continue;
    if (rule.excludePatterns.some((pattern) => globMatch(relToSource, pattern))) continue;
    matched.push(normalized);
  }
  return matched;
}

export async function findUnchangedMatchingFiles(changedFiles: string[], rule: ReviewRule, projectRoot: string): Promise<string[]> {
  const changedSet = new Set(changedFiles.map(normalizePath));
  const sourceRel = normalizePath(relative(projectRoot, rule.sourceDir));
  if (sourceRel.startsWith("..")) return [];

  const all = await listFiles(rule.sourceDir);
  const results: string[] = [];
  for (const fullPath of all) {
    const relProject = normalizePath(relative(projectRoot, fullPath));
    if (changedSet.has(relProject)) continue;
    const relSource = relativeToDir(relProject, sourceRel);
    if (relSource === null) continue;
    if (!rule.includePatterns.some((pattern) => globMatch(relSource, pattern))) continue;
    if (rule.excludePatterns.some((pattern) => globMatch(relSource, pattern))) continue;
    results.push(relProject);
  }
  return [...new Set(results)].sort();
}

export function globMatch(filepath: string, pattern: string): boolean {
  return new RegExp(globToRegex(pattern)).test(filepath);
}

function relativeToDir(filepath: string, dirPath: string): string | null {
  if (dirPath === "" || dirPath === ".") return filepath;
  const prefix = dirPath.replace(/\/$/, "") + "/";
  return filepath.startsWith(prefix) ? filepath.slice(prefix.length) : null;
}

function globToRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length;) {
    if (pattern.slice(i, i + 2) === "**") {
      if (pattern[i + 2] === "/") {
        out += "(?:.+/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += pattern[i].replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
      i += 1;
    }
  }
  return `^${out}$`;
}

async function listFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile()) files.push(full);
    else if (entry.isDirectory()) files.push(...await listFiles(full));
  }
  return files;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}
