import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ReferenceFile, ReviewTaskNative } from "../types/reviews.js";

export const REVIEW_INSTRUCTIONS_DIR = ".deepwork/tmp/review_instructions";
const MAX_INLINE_FILES = 10;
const MAX_INLINE_TOTAL_BYTES = 100_000;
const PRECOMPUTE_TIMEOUT_MS = 60_000;
const SANITIZE_RE = /[^a-zA-Z0-9\-_.]/g;
const FENCE_LANG_BY_EXT: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".md": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

export type WrittenReviewTask = {
  task: ReviewTaskNative;
  reviewId: string;
  filePath: string;
};

export function computeReviewId(task: ReviewTaskNative, projectRoot: string): string {
  const rulePart = task.ruleName.replace(SANITIZE_RE, "-");
  const pathsPart = pathsComponent(task.filesToReview);
  const hashPart = contentHash(task, projectRoot);
  return `${rulePart}--${pathsPart}--${hashPart}`;
}

export async function writeInstructionFiles(tasks: ReviewTaskNative[], projectRoot: string): Promise<WrittenReviewTask[]> {
  const root = resolve(projectRoot);
  const instructionsDir = join(root, REVIEW_INSTRUCTIONS_DIR);
  await mkdir(instructionsDir, { recursive: true });
  await clearStaleInstructionFiles(instructionsDir);

  const precomputed = await runPrecomputeCommands(tasks, root);
  const written: WrittenReviewTask[] = [];
  for (const task of tasks) {
    const reviewId = computeReviewId(task, root);
    const filePath = join(instructionsDir, `${reviewId}.md`);
    if (existsSync(join(instructionsDir, `${reviewId}.passed`))) continue;

    const content = await buildInstructionFile(task, reviewId, root, task.precomputedInfoBashCommand ? precomputed.get(task.precomputedInfoBashCommand) : undefined);
    await safeWrite(filePath, content);
    written.push({ task, reviewId, filePath });
  }
  return written;
}

export async function buildInstructionFile(task: ReviewTaskNative, reviewId: string, projectRoot: string, precomputedInfo?: string): Promise<string> {
  const parts: string[] = [];
  parts.push(`# Review: ${task.ruleName} — ${describeScope(task)}\n`);

  parts.push("## Project Root\n");
  parts.push(`**All file paths in this document are relative to \`${projectRoot}\`.** When reading any file below with Pi file-reading tools, you MUST construct the absolute path by prepending this project root. Do NOT read files relative to your current working directory — it may differ from the project root.`);
  parts.push("");

  parts.push("## Review Instructions\n");
  parts.push(resolveInstructionPlaceholders(task).trim());
  parts.push("");

  if (task.referenceFiles.length > 0) {
    parts.push("## Relevant File Contents\n");
    parts.push(await buildReferenceFilesSection(task.referenceFiles));
    parts.push("");
  }

  if (task.filesToReview.length > 0) {
    parts.push("## Files to Review\n");
    parts.push("Use Pi's file-reading tools to inspect these paths under the Project Root. Do not rely on Claude-specific @path auto-read behavior.\n");
    for (const filepath of task.filesToReview) parts.push(`- ${filepath}`);
    parts.push("");
  }

  if (task.inlineContent !== undefined) {
    parts.push("## Content to Review\n");
    parts.push(task.inlineContent.replace(/\s+$/, ""));
    parts.push("");
  }

  if (task.additionalFiles.length > 0) {
    parts.push("## Unchanged Matching Files\n");
    parts.push("These files match the review patterns but were not changed. They are provided for context. Use Pi's file-reading tools if you need to inspect them.\n");
    for (const filepath of task.additionalFiles) parts.push(`- ${filepath}`);
    parts.push("");
  }

  if (task.allChangedFilenames && task.allChangedFilenames.length > 0) {
    parts.push("## All Changed Files\n");
    parts.push("The following files were changed in this changeset (listed for context, not all are subject to this review).\n");
    for (const filepath of task.allChangedFilenames) parts.push(`- ${filepath}`);
    parts.push("");
  }

  if (precomputedInfo !== undefined) {
    parts.push("## Precomputed Context\n");
    parts.push(precomputedInfo.replace(/\s+$/, ""));
    parts.push("");
  }

  parts.push("## After Review\n");
  parts.push("Report findings with file paths and line references when possible. If this review passes with no actionable findings, call the native Pi tool `deepwork_mark_review_as_passed` with:");
  parts.push(`- \`review_id\`: \`"${reviewId}"\``);
  parts.push("Do not mark this review as passed while actionable findings remain.");
  parts.push("");

  if (task.sourceLocation) {
    parts.push("---\n");
    parts.push(`This review was requested by the policy at \`${task.sourceLocation}\`.`);
    parts.push("");
  }

  return parts.join("\n");
}

export function formatReviewTasksForPi(written: WrittenReviewTask[], projectRoot: string): string {
  if (written.length === 0) return "No review tasks to execute.";
  const lines = [
    "Run the following DeepWork review tasks.",
    "If a Pi subagent or parallel-delegation extension is available, dispatch these tasks in parallel. Otherwise, complete them one at a time in this session.",
    "Read each prompt_file and follow its instructions exactly. Report findings with file and line references.\n",
  ];
  for (const item of written) {
    lines.push(`description: ${taskDescription(item.task)}`);
    lines.push(`\treviewer: ${item.task.agentName || "deepwork-reviewer"}`);
    lines.push(`\tprompt_file: ${relative(projectRoot, item.filePath)}`);
    lines.push(`\treview_id: ${item.reviewId}`);
    lines.push(`\trule_name: ${item.task.ruleName}`);
    lines.push(`\tfiles_to_review: ${item.task.filesToReview.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function resolveInstructionPlaceholders(task: ReviewTaskNative): string {
  const primaryFile = task.filesToReview[0] ?? "inline content";
  return task.instructions.replaceAll("{file_path}", primaryFile);
}

function taskDescription(task: ReviewTaskNative): string {
  const pathPart = task.sourceLocation.split(":").slice(0, -1).join(":");
  if (pathPart.endsWith("deepschema.yml") || basename(pathPart).startsWith(".deepschema.")) return `Review ${task.ruleName}`;
  const parent = basename(pathPart ? pathPart.replace(/\/.deepreview$/, "") : "");
  const prefix = parent && parent !== ".deepreview" ? `${parent}/` : "";
  return `Review ${prefix}${task.ruleName}`;
}

function describeScope(task: ReviewTaskNative): string {
  if (task.filesToReview.length === 0 && task.inlineContent !== undefined) return "inline content";
  if (task.filesToReview.length === 1) return task.filesToReview[0];
  return `${task.filesToReview.length} files`;
}

async function buildReferenceFilesSection(referenceFiles: ReferenceFile[]): Promise<string> {
  const parts: string[] = [];
  let totalBytes = 0;
  let inlinedCount = 0;
  const omitted: string[] = [];

  for (const ref of referenceFiles) {
    if (inlinedCount >= MAX_INLINE_FILES || totalBytes >= MAX_INLINE_TOTAL_BYTES) {
      omitted.push(ref.relativeLabel);
      continue;
    }
    const header = [`### ${ref.relativeLabel}`, ref.description?.trim()].filter(Boolean).join("\n\n");
    let content: string;
    try {
      content = await readFile(ref.path, "utf8");
    } catch (error) {
      parts.push(`${header}\n\n(could not inline ${ref.relativeLabel}: ${error instanceof Error ? error.message : String(error)})\n`);
      continue;
    }

    const bytes = Buffer.byteLength(content, "utf8");
    const remaining = MAX_INLINE_TOTAL_BYTES - totalBytes;
    let rendered = content;
    let consumed = bytes;
    if (bytes > remaining) {
      rendered = Buffer.from(content, "utf8").subarray(0, remaining).toString("utf8");
      rendered += `\n... (truncated: file is ${bytes} bytes, budget left was ${remaining})`;
      consumed = remaining;
    }
    parts.push(`${header}\n\n\`\`\`${FENCE_LANG_BY_EXT[extname(ref.path).toLowerCase()] ?? "text"}\n${rendered}\n\`\`\`\n`);
    totalBytes += consumed;
    inlinedCount += 1;
  }

  if (omitted.length > 0) parts.push(`\n_(${omitted.length} more reference file(s) omitted due to size/count caps: ${omitted.join(", ")})_\n`);
  return parts.join("");
}

async function clearStaleInstructionFiles(instructionsDir: string): Promise<void> {
  const entries = await readdir(instructionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filepath = join(instructionsDir, entry.name);
    const passedMarker = filepath.replace(/\.md$/, ".passed");
    if (!existsSync(passedMarker)) await unlink(filepath);
  }
}

async function safeWrite(filepath: string, content: string): Promise<void> {
  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filepath);
}

function pathsComponent(files: string[]): string {
  if (files.length === 0) return "inline";
  const joined = [...files].sort().map((file) => file.replaceAll("/", "-")).join("_AND_");
  return joined.length > 100 ? `${files.length}_files` : joined;
}

function contentHash(task: ReviewTaskNative, projectRoot: string): string {
  const hash = createHash("sha256");
  if (task.cacheInvalidatesOn === "changed_file_set") {
    hash.update("changed_file_set\0");
    hash.update([...task.filesToReview].sort().join("\0"));
    if (task.inlineContent !== undefined) {
      hash.update("\0INLINE\0");
      hash.update(task.inlineContent);
    }
  } else {
    hash.update("file_content\0");
    for (const filepath of [...task.filesToReview].sort()) {
      try {
        hash.update(readFileSync(join(projectRoot, filepath), "utf8"));
      } catch {
        hash.update("MISSING");
      }
    }
    if (task.inlineContent !== undefined) {
      hash.update("\0INLINE\0");
      hash.update(task.inlineContent);
    }
  }
  return hash.digest("hex").slice(0, 12);
}

async function runPrecomputeCommands(tasks: ReviewTaskNative[], projectRoot: string): Promise<Map<string, string>> {
  const commands = [...new Set(tasks.map((task) => task.precomputedInfoBashCommand).filter((value): value is string => Boolean(value)))];
  const results = new Map<string, string>();
  await Promise.all(commands.map(async (command) => {
    results.set(command, await runPrecomputeCommand(command, projectRoot));
  }));
  return results;
}

function runPrecomputeCommand(command: string, projectRoot: string): Promise<string> {
  return new Promise((resolveResult) => {
    const child = spawn(command, { cwd: projectRoot, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolveResult(`**Precompute command timed out** after ${PRECOMPUTE_TIMEOUT_MS / 1000}s:\n\`${command}\``);
    }, PRECOMPUTE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveResult(`**Precompute command error**: ${error.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveResult(stdout);
      else resolveResult(`**Precompute command failed** (exit code ${code}):\n\`\`\`\n${stderr.trim()}\n\`\`\``);
    });
  });
}
