import { existsSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import type { DiscoveryError, ReviewRule, ReviewTaskNative } from "../types/reviews.js";
import type { JsonObject, JsonValue } from "../bridge.js";
import { formatSourceLocation, loadAllReviewRules } from "./config.js";
import { generateDeepSchemaReviewRules } from "../deepschema/reviews.js";
import { getChangedFiles, getLastCommitFiles } from "./git.js";
import { findUnchangedMatchingFiles, matchFilesToRules, matchRule } from "./matching.js";
import { computeReviewId, formatReviewTasksForPi, REVIEW_INSTRUCTIONS_DIR, writeInstructionFiles } from "./instructions.js";

/**
 * TODO: Make post-commit reminder delivery mode explicit.
 *
 * Interactive Pi sessions should ask the user whether to run `/review` because
 * the fastest high-quality path is a one-click human choice. Fully autonomous
 * runs should not require `ask_user_question`, since no human may be present to
 * answer and the prompt can stall completion. Add a small policy switch, likely
 * an environment variable such as `DEEPWORK_POST_COMMIT_REVIEW_MODE`, with modes
 * like `interactive` (ask), `autonomous` (emit non-blocking next-action guidance),
 * and possibly `off` for CI/batch jobs. Prefer an explicit env/config signal over
 * guessing from tool availability, but tool availability can be a fallback when
 * Pi exposes no run-mode metadata.
 */
export const POST_COMMIT_REVIEW_REMINDER_CONTEXT = "You **MUST** use the ask_user_question tool to offer the user a quick quality check: run `/review` now for the changes they just committed, or skip for now. Do not run `/review` unless the user chooses it.";
export const POST_COMMIT_ALL_PASSED_CONTEXT = "No re-review needed - all reviews passed for committed files";

export async function getReviewInstructionsNative(params: JsonObject, projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const { rules, errors } = await loadNativeReviewRules(root);
  if (rules.length === 0) {
    if (errors.length > 0) return `No valid review rules found. Parse errors:\n${formatDiscoveryWarnings(errors)}`;
    return "No .deepreview configuration files or DeepSchema definitions found.";
  }

  const explicitFiles = Array.isArray(params.files) ? params.files.map(String) : null;
  const cadence = reviewCadenceParam(params);
  let changedFiles: string[];
  let candidateRules = filterRulesByCadence(rules, cadence);
  if (explicitFiles) {
    changedFiles = [...new Set(explicitFiles)].sort();
    if (cadence !== "pull_request") candidateRules = candidateRules.filter((rule) => !ruleIsCatchAll(rule));
  } else {
    changedFiles = await getChangedFiles(root);
  }

  if (changedFiles.length === 0) return "No changed files detected.";

  const tasks = await enrichTasks(matchFilesToRules(changedFiles, candidateRules, root, "pi"), candidateRules, changedFiles, root);
  if (tasks.length === 0) return "No review rules matched the changed files.";

  const written = await writeInstructionFiles(tasks, root);
  let output = formatReviewTasksForPi(written, root);
  if (errors.length > 0) output = `Warning: Some .deepreview files could not be parsed:\n${formatDiscoveryWarnings(errors)}\n\n${output}`;
  return output;
}

export async function getConfiguredReviewsNative(params: JsonObject, projectRoot: string): Promise<JsonValue> {
  const root = resolve(projectRoot);
  const { rules, errors } = await loadNativeReviewRules(root);
  const explicitFiles = Array.isArray(params.only_rules_matching_files)
    ? params.only_rules_matching_files.map(String)
    : Array.isArray(params.files)
      ? params.files.map(String)
      : null;

  const cadence = reviewCadenceParam(params, "all");
  const cadenceRules = filterRulesByCadence(rules, cadence);
  const selectedRules = explicitFiles
    ? cadenceRules.filter((rule) => (cadence === "pull_request" || !ruleIsCatchAll(rule)) && matchRule(explicitFiles, rule, root).length > 0)
    : cadenceRules;

  return [
    ...selectedRules.map((rule) => ({
      name: rule.name,
      description: rule.description,
      defining_file: formatSourceLocation(rule, root),
      strategy: rule.strategy,
      cadence: rule.cadence,
      cache_invalidates_on: rule.cacheInvalidatesOn,
      include_patterns: rule.includePatterns,
      exclude_patterns: rule.excludePatterns,
      reviewer: rule.agent?.pi ?? rule.agent?.codex ?? rule.agent?.claude ?? null,
      all_changed_filenames: rule.allChangedFilenames,
      unchanged_matching_files: rule.unchangedMatchingFiles,
    })),
    ...errors.map((error) => ({
      name: `PARSE_ERROR:${relative(root, error.filePath).startsWith("..") ? error.filePath : relative(root, error.filePath)}`,
      description: error.error,
      defining_file: error.filePath,
    })),
  ];
}

export async function hasUnpassedReviewForCurrentChanges(projectRoot: string): Promise<boolean> {
  const root = resolve(projectRoot);
  let changedFiles: string[];
  try {
    changedFiles = await getChangedFiles(root);
  } catch {
    return false;
  }
  return hasUnpassedReviewForFiles(root, changedFiles, { includeCatchAllRules: true });
}

export async function hasUnpassedReviewForLastCommit(projectRoot: string): Promise<boolean> {
  const root = resolve(projectRoot);
  let committedFiles: string[];
  try {
    committedFiles = await getLastCommitFiles(root);
  } catch {
    return false;
  }
  return hasUnpassedReviewForFiles(root, committedFiles);
}

export async function getPostCommitReviewContextNative(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  try {
    const committedFiles = await getLastCommitFiles(root);
    return await hasUnpassedReviewForFiles(root, committedFiles)
      ? POST_COMMIT_REVIEW_REMINDER_CONTEXT
      : POST_COMMIT_ALL_PASSED_CONTEXT;
  } catch {
    return POST_COMMIT_REVIEW_REMINDER_CONTEXT;
  }
}

export async function hasUnpassedReviewForFiles(projectRoot: string, files: string[], options: { includeCatchAllRules?: boolean } = {}): Promise<boolean> {
  const root = resolve(projectRoot);
  const changedFiles = [...new Set(files.map(String).filter(Boolean))].sort();
  if (changedFiles.length === 0) return false;

  const { rules } = await loadNativeReviewRules(root);
  const changeCycleRules = filterRulesByCadence(rules, "change_cycle");
  const candidateRules = options.includeCatchAllRules ? changeCycleRules : changeCycleRules.filter((rule) => !ruleIsCatchAll(rule));
  const tasks = await enrichTasks(matchFilesToRules(changedFiles, candidateRules, root, "pi"), candidateRules, changedFiles, root);
  return tasks.some((task) => !existsSync(join(root, REVIEW_INSTRUCTIONS_DIR, `${computeReviewId(task, root)}.passed`)));
}

async function enrichTasks(tasks: ReviewTaskNative[], rules: ReviewRule[], changedFiles: string[], projectRoot: string): Promise<ReviewTaskNative[]> {
  const bySourceAndName = new Map(rules.map((rule) => [`${formatSourceLocation(rule, projectRoot)}\0${rule.name}`, rule]));
  const enriched: ReviewTaskNative[] = [];
  for (const task of tasks) {
    const rule = bySourceAndName.get(`${task.sourceLocation}\0${task.ruleName}`);
    if (rule?.unchangedMatchingFiles) {
      enriched.push({ ...task, additionalFiles: await findUnchangedMatchingFiles(changedFiles, rule, projectRoot) });
    } else {
      enriched.push(task);
    }
  }
  return enriched;
}

async function loadNativeReviewRules(root: string): Promise<{ rules: ReviewRule[]; errors: DiscoveryError[] }> {
  const deepreview = await loadAllReviewRules(root);
  const deepschema = await generateDeepSchemaReviewRules(root);
  return {
    rules: [...deepreview.rules, ...deepschema.rules],
    errors: [...deepreview.errors, ...deepschema.errors.map((error) => ({ filePath: error.filePath, error: error.error }))],
  };
}

function formatDiscoveryWarnings(errors: DiscoveryError[]): string {
  return errors.map((error) => `  - ${error.filePath}: ${error.error}`).join("\n");
}

function reviewCadenceParam(params: JsonObject, defaultValue: "change_cycle" | "pull_request" | "all" = "change_cycle"): "change_cycle" | "pull_request" | "all" {
  const raw = params.review_cadence ?? params.cadence ?? params.review_mode;
  if (raw === "pull_request" || raw === "pr") return "pull_request";
  if (raw === "change_cycle" || raw === "normal") return "change_cycle";
  if (raw === "all") return "all";
  return defaultValue;
}

function filterRulesByCadence(rules: ReviewRule[], cadence: "change_cycle" | "pull_request" | "all"): ReviewRule[] {
  if (cadence === "all") return rules;
  return rules.filter((rule) => rule.cadence === cadence);
}

export function ruleIsCatchAll(rule: ReviewRule): boolean {
  return rule.includePatterns.length > 0 && rule.includePatterns.every(isCatchAllPattern);
}

function isCatchAllPattern(pattern: string): boolean {
  return pattern !== "" && [...pattern].every((char) => char === "*" || char === "/");
}
