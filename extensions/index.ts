import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  abortWorkflow,
  finishedStep,
  getActiveWorkflowStack,
  getConfiguredReviews,
  getNamedSchemas,
  getReviewInstructions,
  getSessionJob,
  getWorkflows,
  goToStep,
  hasApplicableReviews,
  markReviewAsPassed,
  parseReviewTasks,
  registerSessionJob,
  runDeepSchemaWriteHook,
  startWorkflow,
  type JsonObject,
  type JsonValue,
  type ReviewTask,
} from "../src/bridge.js";
import {
  formatLaunchedReviewSubagentsForAgent,
  launchReviewSubagentsIfAvailable,
} from "../src/reviews/subagents.js";

const fallbackSessionId = `pi-${randomUUID()}`;
const extensionDir = dirname(fileURLToPath(import.meta.url));
const configureReviewsSkillPath = resolve(extensionDir, "..", "skills", "configure-reviews", "SKILL.md");
const recordSkillPath = resolve(extensionDir, "..", "skills", "record", "SKILL.md");
const recordingStateVersion = 1;

type RecordingState = {
  version: number;
  session_id: string;
  workflow_name: string;
  started_at: string;
  invocation_context: string;
  session_context: string;
};

export default function deepworkPi(pi: ExtensionAPI) {
  const pendingSubagentReviewPasses = new Map<string, string>();
  registerDeepWorkTools(pi, pendingSubagentReviewPasses);
  registerCommands(pi, pendingSubagentReviewPasses);
  registerLifecycleHooks(pi, pendingSubagentReviewPasses);
}

function registerDeepWorkTools(pi: ExtensionAPI, pendingSubagentReviewPasses: Map<string, string>): void {
  pi.registerTool(defineTool({
    name: "deepwork_get_workflows",
    label: "DeepWork Workflows",
    description: "List available DeepWork workflows using the native Pi bridge. Call this first to discover jobs and workflows.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return toolResult(await getWorkflows(bridgeOptions(ctx)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_register_session_job",
    label: "Register DeepWork Session Job",
    description: "Register a transient DeepWork job definition scoped to the current Pi session.",
    parameters: Type.Object({
      job_name: Type.String({ description: "Session job name. Must match the job YAML name and ^[a-z][a-z0-9_]*$." }),
      job_definition_yaml: Type.String({ description: "Complete DeepWork job.yml content to validate and register." }),
      session_id: Type.Optional(Type.String({ description: "Optional DeepWork/Pi session ID. Defaults to the current Pi session." })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent/subagent ID." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await registerSessionJob(params as JsonObject, bridgeOptions(ctx, params)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_get_session_job",
    label: "Get DeepWork Session Job",
    description: "Retrieve a transient DeepWork job definition registered in the current Pi session.",
    parameters: Type.Object({
      job_name: Type.String({ description: "Session job name." }),
      session_id: Type.Optional(Type.String({ description: "Optional DeepWork/Pi session ID. Defaults to the current Pi session." })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent/subagent ID." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await getSessionJob(params as JsonObject, bridgeOptions(ctx, params)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_start_workflow",
    label: "Start DeepWork Workflow",
    description: "Start a DeepWork workflow and return the first step instructions. Uses native Pi tooling, not MCP.",
    parameters: Type.Object({
      goal: Type.String({ description: "What the user wants to accomplish." }),
      job_name: Type.String({ description: "DeepWork job name." }),
      workflow_name: Type.String({ description: "Workflow name within the job." }),
      inputs: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional first-step inputs keyed by argument name." })),
      session_id: Type.Optional(Type.String({ description: "Optional DeepWork/Pi session ID. Defaults to the current Pi session." })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent/subagent ID." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await startWorkflow(params as JsonObject, bridgeOptions(ctx, params)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_finished_step",
    label: "Finish DeepWork Step",
    description: "Submit outputs for the current DeepWork step and receive next-step, needs-work, or completion status.",
    parameters: Type.Object({
      outputs: Type.Record(Type.String(), Type.Any(), { description: "Step outputs keyed by declared output name." }),
      work_summary: Type.Optional(Type.String({ description: "Optional summary of work completed." })),
      quality_review_override_reason: Type.Optional(Type.String({ description: "Reason to skip quality review for this step." })),
      session_id: Type.Optional(Type.String({ description: "Optional DeepWork/Pi session ID. Defaults to the current Pi session." })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent/subagent ID." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await finishedStep(params as JsonObject, bridgeOptions(ctx, params)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_abort_workflow",
    label: "Abort DeepWork Workflow",
    description: "Abort the current DeepWork workflow and return to the parent workflow if one exists.",
    parameters: Type.Object({
      explanation: Type.String({ description: "Why the workflow is being aborted." }),
      session_id: Type.Optional(Type.String({ description: "Optional DeepWork/Pi session ID. Defaults to the current Pi session." })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent/subagent ID." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await abortWorkflow(params as JsonObject, bridgeOptions(ctx, params)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_go_to_step",
    label: "Go To DeepWork Step",
    description: "Navigate back to a prior step in the current DeepWork workflow without deleting files on disk.",
    parameters: Type.Object({
      step_id: Type.String({ description: "Step name to return to." }),
      session_id: Type.Optional(Type.String({ description: "Optional DeepWork/Pi session ID. Defaults to the current Pi session." })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent/subagent ID." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await goToStep(params as JsonObject, bridgeOptions(ctx, params)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_get_review_instructions",
    label: "DeepWork Review Instructions",
    description: "Generate native Pi DeepWork review tasks for changed files or an explicit file list, including optional PR-cadence reviews.",
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String(), { description: "Optional explicit files to review." })),
      review_cadence: Type.Optional(Type.Union([
        Type.Literal("change_cycle"),
        Type.Literal("pull_request"),
      ], { description: "Review cadence to run. Defaults to change_cycle; use pull_request for PR-level reviews." })),
      autostart_reviews_if_possible: Type.Optional(Type.Boolean({ description: "Whether to automatically launch generated review tasks through available review subagents. Defaults to true. Set false when only validating which review tasks would be generated." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await getReviewInstructions(params as JsonObject, bridgeOptions(ctx));
      const tasks = parseReviewTasks(output);
      if (tasks.length === 0) return toolResult(output, { tasks });
      const autostartReviewsIfPossible = (params as { autostart_reviews_if_possible?: boolean } | undefined)?.autostart_reviews_if_possible !== false;
      if (!autostartReviewsIfPossible) return toolResult(output, { tasks });

      const launch = await launchReviewSubagentsIfAvailable({ events: pi.events, tasks, cwd: ctx.cwd });
      if (launch.status === "started") {
        rememberLaunchedReviewPasses(pendingSubagentReviewPasses, launch.reviews, ctx.cwd);
        return toolResult(formatLaunchedReviewSubagentsForAgent(launch), {
          subagents: {
            request_id: launch.requestId,
            status: launch.status,
            reviews: launch.reviews,
          },
        });
      }

      return toolResult(output, { tasks });
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_get_configured_reviews",
    label: "DeepWork Configured Reviews",
    description: "List DeepWork review rules configured for this project, optionally filtered to specific files.",
    parameters: Type.Object({
      only_rules_matching_files: Type.Optional(Type.Array(Type.String(), { description: "Optional file paths used to filter applicable review rules." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await getConfiguredReviews(params as JsonObject, bridgeOptions(ctx)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_mark_review_as_passed",
    label: "Mark DeepWork Review Passed",
    description: "Mark a DeepWork review as passed so it is not re-run until its configured cache invalidation input changes.",
    parameters: Type.Object({
      review_id: Type.String({ description: "Review ID from the review instruction file." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await markReviewAsPassed(params as JsonObject, bridgeOptions(ctx)));
    },
  }));

  pi.registerTool(defineTool({
    name: "deepwork_get_named_schemas",
    label: "DeepWork Named Schemas",
    description: "List named DeepSchemas discovered across project-local, standard, and environment-configured sources.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return toolResult(await getNamedSchemas(bridgeOptions(ctx)));
    },
  }));
}

function registerCommands(pi: ExtensionAPI, pendingSubagentReviewPasses: Map<string, string>): void {
  pi.registerCommand("review", {
    description: "Run DeepWork Reviews",
    handler: async (args, ctx) => {
      await runDeepworkReview(pi, ctx, args, pendingSubagentReviewPasses);
    },
  });

  pi.registerCommand("deepwork_review", {
    description: "Run DeepWork Reviews",
    handler: async (args, ctx) => {
      await runDeepworkReview(pi, ctx, args, pendingSubagentReviewPasses);
    },
  });

  pi.registerCommand("configure-reviews", {
    description: "Configure DeepWork Reviews",
    handler: async (args, ctx) => {
      await runConfigureReviews(pi, ctx, args);
    },
  });

  pi.registerCommand("record", {
    description: "Record a workflow and turn it into a DeepWork job",
    handler: async (args, ctx) => {
      await runRecord(pi, ctx, args);
    },
  });
}

function registerLifecycleHooks(pi: ExtensionAPI, pendingSubagentReviewPasses: Map<string, string>): void {
  pi.events?.on?.("subagent:async-complete", (event) => {
    void markSubagentReportedReviewPasses(event, pendingSubagentReviewPasses);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "new") return;
    try {
      await abortWorkflow(
        { explanation: "Pi started a new session; aborting DeepWork workflow state tied to the previous session." },
        bridgeOptions(ctx),
      );
    } catch {
      // Starting a new Pi session must stay safe when there is no active
      // DeepWork workflow for the old session or workflow state is stale.
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const stack = await getActiveWorkflowStack(ctx.cwd);
      if (!stack) return;
      pi.sendMessage(
        { customType: "deepwork-context", content: stack, display: false },
        { deliverAs: "followUp" },
      );
    } catch {
      // DeepWork context restoration must not fail Pi startup.
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      const stack = await getActiveWorkflowStack(ctx.cwd);
      if (!stack) return;
      return {
        message: {
          customType: "deepwork-context",
          content: stack,
          display: false,
        },
      };
    } catch {
      return;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      if (event.toolName === "bash") {
        const command = String((event.input as { command?: unknown }).command ?? "");
        if (/\bgit\s+commit\b/.test(command) && bashResultSucceeded(event) && await hasApplicableReviews(ctx.cwd)) {
          pi.sendMessage(
            {
              customType: "deepwork-review-reminder",
              content: "A git commit just ran. This project has DeepWork review rules; run /review before merging if those rules apply to this branch.",
              display: true,
            },
            { deliverAs: "followUp" },
          );
        }
      }

      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const filePath = toolFilePath(event.input);
      if (!filePath) return;

      const context = await runDeepSchemaWriteHook(ctx.cwd, event.toolName, filePath);
      if (!context) return;

      return {
        content: [
          ...(Array.isArray(event.content) ? event.content : []),
          { type: "text", text: context },
        ],
        details: {
          ...(typeof event.details === "object" && event.details !== null ? event.details : {}),
          deepwork: { deepschemaContext: context },
        },
      };
    } catch {
      return;
    }
  });
}

async function runRecord(pi: ExtensionAPI, ctx: ExtensionContext, args = ""): Promise<void> {
  const workflowName = args.trim();
  let guidance = "Ask the user what to call the workflow, have them do the process naturally in Pi, capture decisions and repeatable steps, then run /deepwork learn when ready to create the job.";

  try {
    guidance = summarizeRecordGuidance(await readFile(recordSkillPath, "utf8"));
  } catch {
    // Keep /record usable in partial installs and tests.
  }

  const state = await persistRecordingState(ctx, workflowName, guidance);

  pi.sendMessage(
    {
      customType: "deepwork-record",
      content: recordPrompt(workflowName, guidance, relative(ctx.cwd, recordingStatePath(ctx)), state.session_context),
      display: true,
    },
    { deliverAs: "followUp" },
  );
}

async function runConfigureReviews(pi: ExtensionAPI, ctx: ExtensionContext, args = ""): Promise<void> {
  const files = parseReviewFileFilters(args);
  const existingFiles = await findDeepReviewFiles(ctx.cwd).catch(() => []);
  let guidance = "Use the configure-reviews skill guidance to create or update .deepreview files.";
  let configuredReviews: JsonValue;
  let reviewPreview = "";

  try {
    guidance = summarizeConfigureReviewsGuidance(await readFile(configureReviewsSkillPath, "utf8"));
  } catch {
    // Keep command usable if package files are unavailable in a test or partial install.
  }

  try {
    configuredReviews = await getConfiguredReviews(files.length > 0 ? { only_rules_matching_files: files } : {}, bridgeOptions(ctx));
  } catch (error) {
    configuredReviews = [{ error: `Could not inspect configured reviews: ${String(error)}` }];
  }

  if (files.length > 0) {
    try {
      reviewPreview = await getReviewInstructions({ files }, bridgeOptions(ctx));
    } catch (error) {
      reviewPreview = `Could not generate review instruction preview for ${files.join(", ")}: ${String(error)}`;
    }
  }

  pi.sendMessage(
    {
      customType: "deepwork-configure-reviews",
      content: configureReviewsPrompt({ files, existingFiles, guidance, configuredReviews, reviewPreview }),
      display: true,
    },
    { deliverAs: "followUp" },
  );
}

async function runDeepworkReview(pi: ExtensionAPI, ctx: ExtensionContext, args = "", pendingSubagentReviewPasses: Map<string, string>): Promise<void> {
  const parsed = parseReviewArgs(args);
  const files = parsed.files;
  let output: string;
  try {
    output = await getReviewInstructions({ ...(files.length > 0 ? { files } : {}), review_cadence: parsed.cadence }, bridgeOptions(ctx));
  } catch (error) {
    pi.sendMessage(
      {
        customType: "deepwork-review-error",
        content: `DeepWork review setup failed.\n\n${String(error)}`,
        display: true,
      },
      { deliverAs: "followUp" },
    );
    return;
  }

  const tasks = parseReviewTasks(output);
  if (tasks.length === 0) {
    pi.sendMessage(
      {
        customType: "deepwork-review-status",
        content: [
          reviewScopeLine(files),
          output || "No DeepWork review tasks to run.",
        ].filter(Boolean).join("\n\n"),
        display: true,
      },
      { deliverAs: "followUp" },
    );
    return;
  }

  const summary = reviewTaskSummary(tasks, files);
  const launch = await launchReviewSubagentsIfAvailable({ events: pi.events, tasks, cwd: ctx.cwd });
  if (launch.status !== "started") {
    pi.sendMessage(
      {
        customType: "deepwork-review-tasks",
        content: [summary, sequentialReviewPrompt(tasks)].join("\n\n"),
        display: true,
      },
      { deliverAs: "followUp" },
    );
    return;
  }

  rememberLaunchedReviewPasses(pendingSubagentReviewPasses, launch.reviews, ctx.cwd);

  pi.sendMessage(
    {
      customType: "deepwork-review-subagents",
      content: [summary, formatLaunchedReviewSubagentsForAgent(launch), reviewCompletionLoopGuidance()].join("\n\n"),
      display: true,
    },
    { deliverAs: "followUp" },
  );
}

function bridgeOptions(ctx: ExtensionContext, params?: { session_id?: string; agent_id?: string }) {
  return {
    cwd: ctx.cwd,
    sessionId: params?.session_id || safeSessionId(ctx),
    agentId: params?.agent_id,
  };
}

function safeSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() || fallbackSessionId;
  } catch {
    return fallbackSessionId;
  }
}

function toolResult(value: JsonValue | string, details?: JsonObject) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? (typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : { result: value }),
  };
}

function rememberLaunchedReviewPasses(pendingSubagentReviewPasses: Map<string, string>, reviews: Array<{ reviewId?: string }>, cwd: string): void {
  for (const review of reviews) {
    if (review.reviewId) pendingSubagentReviewPasses.set(review.reviewId, cwd);
  }
}

async function markSubagentReportedReviewPasses(event: unknown, pendingSubagentReviewPasses: Map<string, string>): Promise<void> {
  const summaries = subagentCompletionSummaries(event);
  const eventCwd = subagentCompletionCwd(event);
  for (const summary of summaries) {
    for (const reviewId of passedReviewIdsFromSummary(summary)) {
      const cwd = pendingSubagentReviewPasses.get(reviewId) ?? eventCwd;
      if (!cwd || !safeReviewId(reviewId)) continue;
      try {
        await markReviewAsPassed({ review_id: reviewId }, { cwd });
        pendingSubagentReviewPasses.delete(reviewId);
      } catch {
        // Pass-marker handling is best-effort; the normal review result remains visible to the parent.
      }
    }
  }
}

function subagentCompletionCwd(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const cwd = (event as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function subagentCompletionSummaries(event: unknown): string[] {
  if (typeof event !== "object" || event === null) return [];
  const data = event as { summary?: unknown; results?: unknown };
  const summaries: string[] = [];
  if (typeof data.summary === "string") summaries.push(data.summary);
  if (Array.isArray(data.results)) {
    for (const result of data.results) {
      if (typeof result === "object" && result !== null && typeof (result as { summary?: unknown }).summary === "string") {
        summaries.push((result as { summary: string }).summary);
      }
    }
  }
  return summaries;
}

function safeReviewId(reviewId: string): boolean {
  return reviewId.length > 0 && !reviewId.includes("..") && !reviewId.includes("/") && !reviewId.includes("\\");
}

function passedReviewIdsFromSummary(summary: string): string[] {
  const ids = new Set<string>();
  const pattern = /^DEEPWORK_REVIEW_PASSED:\s*([^\s]+)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(summary)) !== null) ids.add(match[1]);
  return [...ids];
}

function reviewCompletionLoopGuidance(): string {
  return [
    "After review findings are reported, apply obviously correct low-risk fixes such as typo fixes and unused import removal.",
    "Ask the user before applying subjective findings, architectural trade-offs, or risky changes.",
    "After fixes are made, re-run /review for the same scope and repeat until no actionable findings remain or the user explicitly stops.",
  ].join(" ");
}

function sequentialReviewPrompt(tasks: ReviewTask[]): string {
  const taskLines = tasks
    .map((task, index) => [
      `${index + 1}. ${task.description}`,
      `   reviewer: ${task.reviewer}`,
      `   prompt_file: ${task.promptFile}`,
      task.reviewId ? `   review_id: ${task.reviewId}` : "",
      task.filesToReview && task.filesToReview.length > 0 ? `   files_to_review: ${task.filesToReview.join(", ")}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");

  return [
    "Pi subagents are not available, so run these DeepWork review tasks sequentially in this session.",
    "For each task, read the prompt_file with Pi file-reading tools and follow its instructions exactly.",
    "Report findings with file and line references. Do not mark a review as passed when actionable findings remain, and do not edit files unless the review instructions explicitly permit it.",
    reviewCompletionLoopGuidance(),
    taskLines,
  ].join("\n\n");
}

function reviewTaskSummary(tasks: ReviewTask[], files: string[]): string {
  const reviewerCounts = new Map<string, number>();
  for (const task of tasks) reviewerCounts.set(task.reviewer, (reviewerCounts.get(task.reviewer) ?? 0) + 1);
  const reviewerSummary = [...reviewerCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reviewer, count]) => `${reviewer}: ${count}`)
    .join(", ");
  const preview = tasks.slice(0, 5).map((task, index) => {
    const scope = task.filesToReview && task.filesToReview.length > 0 ? ` — ${task.filesToReview.join(", ")}` : "";
    const reviewId = task.reviewId ? ` (${task.reviewId})` : "";
    return `${index + 1}. ${task.description}${scope}${reviewId}`;
  }).join("\n");
  const omitted = tasks.length > 5 ? `\n...and ${tasks.length - 5} more task(s).` : "";
  return [
    "DeepWork review task summary:",
    reviewScopeLine(files),
    `Matched task count: ${tasks.length}`,
    reviewerSummary ? `Reviewers: ${reviewerSummary}` : "",
    preview ? `Tasks:\n${preview}${omitted}` : "",
  ].filter(Boolean).join("\n");
}

function recordPrompt(workflowName: string, guidance: string, stateFile: string, sessionContext: string): string {
  const named = workflowName.length > 0;
  return [
    named
      ? `Got it — recording workflow: **${workflowName}**.`
      : "Let's record a workflow. First, ask the user what they would like to call this workflow; a rough name is fine.",
    "Use Pi normally while capturing the user's process as repeatable steps. Track inputs, outputs, decisions, skipped/reordered work, external access needs, quality criteria, and final success signals.",
    `Recording note saved to \`${stateFile}\`. This lightweight native Pi state gives \`/deepwork learn\` a stable handoff even if full Pi transcript APIs are not available to the command.`,
    sessionContext ? `Recent Pi session context captured for learn:\n${sessionContext}` : "No prior Pi session messages were available through the session API; continue describing the process in this chat before running `/deepwork learn`.",
    "When the user is happy with the result, run `/deepwork learn` to convert the recorded process into a draft DeepWork job under `.deepwork/jobs/`.",
    "If `/deepwork learn` cannot start the job-authoring workflow, create a draft job manually with `.deepwork/jobs/<job_name>/job.yml` and step instruction files under `.deepwork/jobs/<job_name>/steps/`.",
    "Native recording flow guidance:",
    guidance,
  ].join("\n\n");
}

async function persistRecordingState(ctx: ExtensionContext, workflowName: string, guidance: string): Promise<RecordingState> {
  const state: RecordingState = {
    version: recordingStateVersion,
    session_id: safeSessionId(ctx),
    workflow_name: workflowName,
    started_at: new Date().toISOString(),
    invocation_context: workflowName,
    session_context: recentSessionContext(ctx),
  };

  try {
    await mkdir(dirname(recordingStatePath(ctx)), { recursive: true });
    await writeFile(recordingStatePath(ctx), `${JSON.stringify({ ...state, guidance_summary: guidance.slice(0, 2000) }, null, 2)}\n`);
  } catch {
    // Recording should remain usable even when lightweight state cannot be persisted.
  }

  return state;
}

function recordingStatePath(ctx: ExtensionContext): string {
  return join(ctx.cwd, ".deepwork", "tmp", "recordings", `${safeFileSegment(safeSessionId(ctx))}.json`);
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "session";
}

function recentSessionContext(ctx: ExtensionContext): string {
  try {
    const manager = ctx.sessionManager as unknown as { buildSessionContext?: () => { messages?: unknown[] }; getBranch?: () => unknown[]; getEntries?: () => unknown[] };
    const messages = manager.buildSessionContext?.().messages ?? entriesToMessages(manager.getBranch?.() ?? manager.getEntries?.() ?? []);
    return summarizeMessages(messages);
  } catch {
    return "";
  }
}

function entriesToMessages(entries: unknown[]): unknown[] {
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const message = (entry as { message?: unknown }).message;
    return message ? [message] : [];
  });
}

function summarizeMessages(messages: unknown[]): string {
  return messages
    .slice(-8)
    .map((message) => summarizeMessage(message))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6000);
}

function summarizeMessage(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const data = message as { role?: unknown; type?: unknown; content?: unknown };
  const role = typeof data.role === "string" ? data.role : typeof data.type === "string" ? data.type : "message";
  const content = stringifyMessageContent(data.content);
  return content ? `${role}: ${content}` : "";
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const text = (part as { text?: unknown; content?: unknown }).text ?? (part as { text?: unknown; content?: unknown }).content;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function configureReviewsPrompt(input: { files: string[]; existingFiles: string[]; guidance: string; configuredReviews: JsonValue; reviewPreview: string }): string {
  const configured = JSON.stringify(input.configuredReviews, null, 2);
  return [
    "Configure DeepWork Reviews for this Pi project.",
    "Use native Pi review tools and .deepreview files; no extra server configuration is required.",
    input.files.length > 0 ? `Validation scope: ${input.files.join(", ")}` : "Validation scope: all configured review rules. Pass files to /configure-reviews to preview matching review tasks for a concrete scope.",
    "",
    "Existing .deepreview files:",
    input.existingFiles.length > 0 ? input.existingFiles.map((file) => `- ${file}`).join("\n") : "- None found. Create a .deepreview file at the repository root or near the files it governs.",
    "",
    "Configured review rules currently visible to DeepWork:",
    "```json",
    configured,
    "```",
    input.reviewPreview ? ["", "Review instruction preview for the requested scope:", "```text", input.reviewPreview, "```"].join("\n") : "",
    "",
    "Recommended configure-reviews flow:",
    input.guidance,
    "",
    "After editing .deepreview files, validate with deepwork_get_configured_reviews and deepwork_get_review_instructions using autostart_reviews_if_possible: false, then ask whether the user wants to run /review after a material set of changes is complete or to confirm a PR is in good form. Mention that running reviews can be expensive.",
  ].filter((part) => part !== "").join("\n");
}

function summarizeRecordGuidance(skillSource: string): string {
  const withoutFrontmatter = skillSource.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const flow = extractSection(withoutFrontmatter, "Flow");
  return (flow || withoutFrontmatter)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/gh api -X PUT[^\n]*/g, "optional GitHub star command omitted from summary"))
    .replace(/\bMCP\b/g, "native Pi")
    .trim();
}

function summarizeConfigureReviewsGuidance(skillSource: string): string {
  const withoutFrontmatter = skillSource.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const requiredReference = extractSection(withoutFrontmatter, "Required Reference");
  const flow = extractSection(withoutFrontmatter, "Flow");
  const placement = extractSection(withoutFrontmatter, "Placement Guidance");
  return [requiredReference, flow, placement]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\bMCP\b/g, "native Pi")
    .trim();
}

function extractSection(source: string, heading: string): string {
  const pattern = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
  return pattern.exec(source)?.[1]?.trim() ?? "";
}

async function findDeepReviewFiles(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
  await walkForDeepReviewFiles(projectRoot, projectRoot, results);
  return results.sort((left, right) => left.localeCompare(right));
}

async function walkForDeepReviewFiles(projectRoot: string, dir: string, results: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".deepwork") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForDeepReviewFiles(projectRoot, fullPath, results);
      continue;
    }
    if (entry.isFile() && entry.name === ".deepreview") {
      results.push(relative(projectRoot, fullPath) || ".deepreview");
    }
  }
}

function reviewScopeLine(files: string[]): string {
  return files.length > 0 ? `Review scope: ${files.join(", ")}` : "Review scope: changed files detected by DeepWork.";
}

function parseReviewFileFilters(args: string): string[] {
  return parseReviewArgs(args).files;
}

type ParsedReviewArgs = {
  files: string[];
  cadence: "change_cycle" | "pull_request";
};

function parseReviewArgs(args: string): ParsedReviewArgs {
  const tokens = tokenizeCommandArgs(args);
  const files: string[] = [];
  let cadence: ParsedReviewArgs["cadence"] = "change_cycle";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--pr" || token === "--pull-request") {
      cadence = "pull_request";
      continue;
    }
    if (token === "--normal" || token === "--change-cycle") {
      cadence = "change_cycle";
      continue;
    }
    if (token === "--" || token === "--files" || token === "--file" || token === "-f") continue;
    if (token.startsWith("--review-cadence=")) {
      const value = token.slice("--review-cadence=".length);
      if (value === "pull_request" || value === "pr") cadence = "pull_request";
      else if (value === "change_cycle" || value === "normal") cadence = "change_cycle";
      continue;
    }
    if (token.startsWith("--cadence=")) {
      const value = token.slice("--cadence=".length);
      if (value === "pull_request" || value === "pr") cadence = "pull_request";
      else if (value === "change_cycle" || value === "normal") cadence = "change_cycle";
      continue;
    }
    if (token.startsWith("--files=")) {
      files.push(...splitFileList(token.slice("--files=".length)));
      continue;
    }
    if (token.startsWith("--file=")) {
      files.push(...splitFileList(token.slice("--file=".length)));
      continue;
    }
    files.push(...splitFileList(token));
  }
  return { files: [...new Set(files.map((file) => file.trim()).filter(Boolean))], cadence };
}

function splitFileList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of args.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function bashResultSucceeded(event: { details?: unknown }): boolean {
  const details = typeof event.details === "object" && event.details !== null ? event.details as Record<string, unknown> : {};
  const code = details.exit_code ?? details.exitCode ?? details.code;
  if (typeof code === "number") return code === 0;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code) === 0;
  const success = details.success ?? details.ok;
  if (typeof success === "boolean") return success;
  return true;
}

function toolFilePath(input: unknown): string | null {
  const data = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const value = data.file_path ?? data.filePath ?? data.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}
