import { execFile } from "node:child_process";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModelAssignments, resolveBengacoonAgentDir, skillTargetFromInput, THINKING_LEVELS, writeModelAssignments } from "./models/config.ts";
import { ReviewCard, WorkflowNoticeCard } from "./workflow-ui.ts";

// Everything here is in the system prompt on every turn, including turns that have nothing to
// do with changing code. That is why the rule is a pointer to the router rather than the
// workflow itself, and why each piece is kept short.
const ORCHESTRATOR_DIR = fileURLToPath(new URL("../orchestrator/", import.meta.url));
const WORKFLOW_NOTICE_TYPE = "bengacoon-workflow-notice";
const REVIEW_EVENT_TYPE = "bengacoon-review-event";
const REVIEWERS = ["tests", "code", "architecture", "performance", "security"];

function deliverReviewEvent(pi, review) {
  pi.sendMessage({ customType: REVIEW_EVENT_TYPE, content: "", display: true, details: review }, { deliverAs: "followUp", triggerTurn: false });
}

function deliverWorkflowNotice(pi, ctx, type, message) {
  try {
    pi.sendMessage({
      customType: WORKFLOW_NOTICE_TYPE,
      content: message,
      display: true,
      details: { type },
    }, { deliverAs: "followUp", triggerTurn: false });
  } catch {
    // A lost transcript card must not hide a workflow warning or error.
    ctx?.ui?.notify(message, type);
  }
}

function readOrUndefined(path) {
  try {
    const contents = readFileSync(path, "utf8").trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}

// A project may replace the voice; it may not replace the artifact language contract. Were the
// contract part of the voice file, anyone writing their own voice would drop it by omission,
// and a voice would start deciding what commit messages and code comments sound like.
// A skill that says "search the context store" without naming one leaves the model to guess
// which of its tools that means. Each adapter names the tools for one store, and is injected
// only when they are actually present — so "no store" is detected rather than assumed, and the
// discipline in context-memory stays free of any particular product.
const CONTEXT_STORE_ADAPTERS = [
  { file: join("context-store", "engram.md"), requires: ["mem_search", "mem_save"] },
];

// MCP tools arrive under a host-specific prefix, so match on the name rather than equality.
export function contextStoreAdapter(selectedTools, dir = ORCHESTRATOR_DIR) {
  const names = Array.isArray(selectedTools) ? selectedTools : [];
  for (const adapter of CONTEXT_STORE_ADAPTERS) {
    const present = adapter.requires.every((required) => names.some((name) => String(name).includes(required)));
    if (present) return readOrUndefined(join(dir, adapter.file));
  }
  return undefined;
}

// The workflow's scripts ship with the package, not with the project it is installed into, so a
// skill cannot name them by a path relative to the project. Skills write `$SYRA_SCRIPTS/...`; this
// is where that variable comes from.
export const SCRIPTS_DIR = fileURLToPath(new URL("../scripts", import.meta.url));

// One line, because it is paid on every turn. The environment variable is what makes the commands
// in the skills run as written; this line is what tells the agent what the variable is, and still
// gives it the path on a runtime that does not pass the variable through.
export function scriptsLocation(scriptsDir = SCRIPTS_DIR) {
  return `Workflow scripts: $SYRA_SCRIPTS is ${JSON.stringify(scriptsDir)}. Run them as the skills write them.`;
}

export function orchestratorPrompt(cwd, selectedTools, dir = ORCHESTRATOR_DIR, scriptsDir = SCRIPTS_DIR) {
  const rule = readOrUndefined(join(dir, "RULE.md"));
  const language = readOrUndefined(join(dir, "LANGUAGE.md"));
  const voice =
    readOrUndefined(join(cwd, ".syra", "voice.md")) ??
    readOrUndefined(join(dir, "voice", "neutral.md"));

  return [rule, language, voice, contextStoreAdapter(selectedTools, dir), rule ? scriptsLocation(scriptsDir) : undefined]
    .filter(Boolean)
    .join("\n\n");
}

const REVIEW_GATE = join(SCRIPTS_DIR, "review-gate.mjs");

// What the user should hear after the gate tries to install its pre-commit hook. A current hook
// and a project that has not opted into review are silent: one changed nothing, and the other is
// not this workflow's business. A skipped install is a warning, because commits in that project
// are not checked and nobody would otherwise know.
export function hookNotice(output) {
  const [status, ...detail] = String(output ?? "").trim().split("\n");
  const message = detail.join("\n").trim();
  if (status === "installed") return { type: "info", message: `Review gate: ${message}` };
  if (status === "skipped") return { type: "warning", message: `Review gate not enforced: ${message}` };
  return undefined;
}

export default function orchestrator(pi) {
  let pendingSkillTarget;
  let skillOverride;

  pi.registerMessageRenderer(REVIEW_EVENT_TYPE, (message, { outputPad }, theme) => new ReviewCard(message.details, theme, outputPad));
  pi.registerMessageRenderer(WORKFLOW_NOTICE_TYPE, (message, { outputPad }, theme) => {
    const type = typeof message.details?.type === "string" ? message.details.type : "info";
    return new WorkflowNoticeCard(type, message.content, theme, outputPad);
  });

  pi.registerTool({
    name: "bengacoon_report_review",
    label: "Report Bengacoon Review",
    description: "Render a Bengacoon reviewer start or result card in the transcript. The review gate receipt remains the commit authority.",
    parameters: Type.Object({
      reviewer: Type.String({ enum: REVIEWERS }),
      state: Type.String({ enum: ["started", "completed"] }),
      verdict: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      findings: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 })),
    }),
    async execute(_toolCallId, params) {
      if (params.state === "completed" && !params.verdict) throw new Error("A completed review requires a verdict.");
      deliverReviewEvent(pi, { reviewer: params.reviewer, state: params.state, ...(params.verdict ? { verdict: params.verdict } : {}), findings: params.findings ?? [] });
      return { content: [{ type: "text", text: `${params.reviewer} review ${params.state}.` }] };
    },
  });

  // The agent's shell commands inherit this process's environment, read fresh on every command,
  // so setting it once at load makes `node "$SYRA_SCRIPTS"/review-gate.mjs` resolve in any project.
  // Ours to set: the name is this workflow's, and an inherited value may point at another install.
  process.env.SYRA_SCRIPTS = SCRIPTS_DIR;

  // Once per session, not per turn, and without waiting for it: installing is a few git calls, and
  // a session should not start later because of them.
  pi.on("session_start", (_event, ctx) => {
    execFile(process.execPath, [REVIEW_GATE, "install-hook"], { cwd: ctx?.cwd ?? process.cwd() }, (error, stdout) => {
      const notice = error
        ? { type: "warning", message: `Review gate hook could not be checked: ${error.message.split("\n")[0]}` }
        : hookNotice(stdout);
      if (notice) deliverWorkflowNotice(pi, ctx, notice.type, notice.message);
    });
  });

  pi.on("input", (event) => {
    pendingSkillTarget = skillTargetFromInput(event.text);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const target = pendingSkillTarget;
    pendingSkillTarget = undefined;
    if (target && ctx.model) {
      try {
        const profileDir = resolveBengacoonAgentDir();
        const assignments = await readModelAssignments(profileDir, new Set([target]));
        const assignment = assignments[target];
        if (assignment) {
          const separator = assignment.model.indexOf("/");
          const model = ctx.modelRegistry.find(assignment.model.slice(0, separator), assignment.model.slice(separator + 1));
          if (!model) throw new Error(`Configured model is unavailable: ${assignment.model}`);
          skillOverride = { model: ctx.model, thinking: pi.getThinkingLevel() };
          if (!(await pi.setModel(model))) throw new Error(`Configured model is not authenticated: ${assignment.model}`);
          pi.setThinkingLevel(assignment.thinking);
        }
      } catch (error) {
        skillOverride = undefined;
        deliverWorkflowNotice(pi, ctx, "warning", `Syra model assignment was not applied: ${error.message}`);
      }
    }

    const addition = orchestratorPrompt(ctx?.cwd ?? process.cwd(), event.systemPromptOptions?.selectedTools);
    if (!addition) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${addition}` };
  });

  pi.registerCommand("syra-models", {
    description: "Configure personal model and thinking assignments for Syra skills and Bengacoon jobs",
    handler: async (_args, ctx) => {
      const profileDir = resolveBengacoonAgentDir();
      const targets = [
        "skill:bug-context", "skill:change-router", "skill:explore", "skill:refactor", "skill:specify", "skill:verified-change",
        "skill:review-architecture", "skill:review-code", "skill:review-performance", "skill:review-security", "skill:review-tests",
        "job:exploration", "job:verification",
      ];
      const available = ctx.modelRegistry.getAvailable();
      const models = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
      while (true) {
        const assignments = await readModelAssignments(profileDir, new Set(targets));
        const choices = targets.map((target) => {
          const assignment = assignments[target];
          return assignment ? `${target} — ${assignment.model} (${assignment.thinking})` : `${target} — Bengacoon default`;
        });
        const targetChoice = await ctx.ui.select("Configure a Syra model assignment", choices);
        if (!targetChoice) return;
        const target = targetChoice.split(" — ", 1)[0];
        const choice = await ctx.ui.select("Select model", ["Clear assignment", ...models.keys()]);
        if (!choice) continue;
        if (choice === "Clear assignment") {
          delete assignments[target];
          await writeModelAssignments(profileDir, assignments, new Set(targets));
          deliverWorkflowNotice(pi, ctx, "info", `Cleared Syra model assignment for ${target}.`);
          continue;
        }
        if (!models.has(choice)) continue;
        const thinking = await ctx.ui.select("Select thinking level", [...THINKING_LEVELS]);
        if (!thinking) continue;
        assignments[target] = { model: choice, thinking };
        await writeModelAssignments(profileDir, assignments, new Set(targets));
        deliverWorkflowNotice(pi, ctx, "info", `Saved Syra model assignment for ${target}.`);
      }
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const previous = skillOverride;
    skillOverride = undefined;
    if (!previous) return;
    if (await pi.setModel(previous.model)) pi.setThinkingLevel(previous.thinking);
    else deliverWorkflowNotice(pi, ctx, "error", "Syra could not restore the model selected before the skill.");
  });
}
