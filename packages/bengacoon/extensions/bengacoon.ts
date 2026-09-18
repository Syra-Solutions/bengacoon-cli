import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { formatTerminalCompletion, JobManager, validateTask } from "./jobs/runner.ts";
import { canonicalWorktree, JobStore, resolveProfileDir } from "./jobs/storage.ts";
import { formatDetail, formatList, jobStatusSnapshot, jobStatusUpdates, statusText } from "./jobs/format.ts";
import { JobCard, JobsView } from "./jobs/ui.ts";
import { readModelAssignments, resolveBengacoonAgentDir } from "./models/config.ts";
import { fetchCodexQuota, parseCodexQuotaHeaders } from "./quota.ts";
import { activeDeliveryWork, receiptState } from "./delivery.ts";
import { SessionChanges } from "./changes.ts";

const LOAD_SIGNAL = "BENGACOON_EXTENSION_LOADED";
const STATUS_SIGNAL = "BENGACOON_STATUS: extension=loaded";
// This must match the model registry provider that owns the Codex OAuth token.
const CODEX_PROVIDER = "openai-codex";
// Avoid a quota request after every turn while refreshing a continuing session promptly.
const QUOTA_REFRESH_MS = 5 * 60_000;

export default function bengacoon(pi) {
  let manager;
  let initialization;
  let deliverySession;
  let showJobDetail;
  let quotaSession;
  let quotaRefreshAt = 0;
  let hasFetchedQuota = false;
  let knownJobStates;
  let sessionChanges = new SessionChanges();

  const deliverJobCard = (record, summary, terminal) => {
    try {
      pi.sendMessage({
        customType: "bengacoon-job-event",
        content: summary,
        display: true,
        details: {
          id: record.id,
          category: record.category,
          status: record.status,
          terminal,
        },
      }, { deliverAs: "followUp", triggerTurn: false });
    } catch {
      // Transcript cards are informational and must not alter a job's persisted lifecycle.
    }
  };

  const setJobStatus = (ctx, records) => {
    const unconfirmed = records.filter((record) => record.status === "termination_unconfirmed").length;
    const warning = unconfirmed > 0 ? `; warning: ${unconfirmed} termination unconfirmed` : "";
    const snapshot = jobStatusSnapshot(records);
    ctx.ui.setStatus("bengacoon-jobs", `${statusText(records)}${warning}`, {
      lines: snapshot.details,
      values: {
        total: String(snapshot.total),
        active: String(snapshot.active),
        failed: String(snapshot.failed),
      },
    });
  };

  const setChangesStatus = (ctx) => {
    const snapshot = sessionChanges.summary();
    ctx.ui.setStatus("bengacoon-changes", `changes: ${snapshot.total} files; +${snapshot.added} -${snapshot.removed}`, {
      lines: snapshot.details,
      values: { changes: JSON.stringify(snapshot) },
    });
  };

  const setDeliveryStatus = (ctx, delivery) => {
    ctx.ui.setStatus("bengacoon-delivery", `delivery: ${delivery.title}; ${delivery.verification}; receipt ${delivery.receipt}`, {
      values: { delivery: JSON.stringify(delivery) },
    });
  };

  const setQuotaStatus = (ctx, quota) => {
    const summary = quota?.limits
      .flatMap((limit) => limit.windows.map((window) => `${limit.name} ${window.label} ${window.remainingPercent}% remaining`))
      .join(", ");
    ctx.ui.setStatus("bengacoon-quota", summary ? `quota: ${summary}` : "quota: unavailable", {
      values: quota ? { usage: JSON.stringify(quota) } : {},
    });
  };

  const quotaFromHeaders = (headers) => {
    const quota = parseCodexQuotaHeaders(headers);
    if (!quota) return undefined;
    const windows = [
      quota.dailyRemainingPercent === undefined
        ? undefined
        : { label: "daily", usedPercent: 100 - quota.dailyRemainingPercent, remainingPercent: quota.dailyRemainingPercent, resetAt: null },
      quota.weeklyRemainingPercent === undefined
        ? undefined
        : { label: "week", usedPercent: 100 - quota.weeklyRemainingPercent, remainingPercent: quota.weeklyRemainingPercent, resetAt: null },
    ].filter(Boolean);
    return { plan: null, limits: windows.length > 0 ? [{ name: "codex", limitReached: false, windows }] : [] };
  };

  const refreshQuota = async (ctx, session) => {
    if (ctx.model?.provider !== CODEX_PROVIDER) return;
    const now = Date.now();
    if (now - quotaRefreshAt < QUOTA_REFRESH_MS) return;
    quotaRefreshAt = now;
    // Authentication failure only makes an optional quota refresh unavailable.
    const token = await ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER).catch(() => undefined);
    const quota = await fetchCodexQuota(token, fetch, Date.now());
    if (quota && quotaSession === session) {
      hasFetchedQuota = quota.limits.length > 0;
      setQuotaStatus(ctx, quota);
    }
  };

  const requestQuotaRefresh = (ctx, session) => {
    void refreshQuota(ctx, session).catch(() => {
      // Quota display must never interrupt a provider response or session startup.
    });
  };

  const initialize = async (ctx, session) => {
    const worktreeRoot = await canonicalWorktree(ctx.cwd);
    const profileDir = await resolveProfileDir(
      process.env.BENGACOON_PROFILE_DIR,
      resolveBengacoonAgentDir(),
      worktreeRoot,
    );
    const jobManager = new JobManager(
      new JobStore(profileDir, worktreeRoot),
      worktreeRoot,
      profileDir,
      (records) => {
        setJobStatus(ctx, records);
        if (!knownJobStates) {
          knownJobStates = new Map(records.map((record) => [record.id, record.status]));
          return;
        }
        for (const record of jobStatusUpdates(records, knownJobStates)) {
          deliverJobCard(record, `${record.title} job ${record.id.slice(0, 8)} is ${record.status}.`, false);
        }
      },
      undefined,
      (record) => {
        if (deliverySession !== session) return;
        deliverJobCard(record, formatTerminalCompletion(record), true);
      },
      (message) => {
        if (deliverySession !== session) return;
        ctx.ui.notify(message, "error");
      },
      async (category) => {
        const target = `job:${category}`;
        const assignments = await readModelAssignments(profileDir, new Set([target]));
        const assignment = assignments[target];
        return assignment ? `${assignment.model}:${assignment.thinking}` : undefined;
      },
    );
    await jobManager.initialize();
    if (deliverySession !== session) {
      await jobManager.shutdown();
      return jobManager;
    }
    manager = jobManager;
    return manager;
  };

  const activeManager = async () => {
    if (!initialization) throw new Error("Bengacoon jobs are not initialized for this session.");
    return initialization;
  };

  const showJobs = async (ctx, text) => {
    if (ctx.mode === "tui") {
      await ctx.ui.custom((_, theme, _keybindings, done) => new JobsView(text, theme, done));
      return;
    }
    if (ctx.mode === "rpc") {
      ctx.ui.notify(text, "info");
    }
  };

  pi.registerMessageRenderer("bengacoon-job-event", (message, { outputPad }, theme) => {
    const details = message.details ?? {};
    const id = typeof details.id === "string" ? details.id : undefined;
    const terminal = details.terminal === true;
    return new JobCard(details, message.content, terminal, theme, outputPad, async () => {
      if (id) await showJobDetail?.(id);
    });
  });

  pi.on("tool_call", (event, ctx) => {
    if ((event.toolName !== "edit" && event.toolName !== "write") || typeof event.input.path !== "string") return;
    const path = resolve(ctx.cwd, event.input.path);
    const displayPath = relative(ctx.cwd, path);
    if (displayPath.startsWith("..")) return;
    try {
      const contents = readFileSync(path, "utf8");
      if (Buffer.byteLength(contents) <= 64 * 1024) sessionChanges.captureBefore(displayPath, contents);
    } catch {
      sessionChanges.captureBefore(displayPath, "");
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError || (event.toolName !== "edit" && event.toolName !== "write") || typeof event.input.path !== "string") return;
    const path = resolve(ctx.cwd, event.input.path);
    const displayPath = relative(ctx.cwd, path);
    if (displayPath.startsWith("..")) return;
    try {
      const contents = readFileSync(path, "utf8");
      if (Buffer.byteLength(contents) > 64 * 1024) return;
      sessionChanges.captureAfter(displayPath, contents);
      setChangesStatus(ctx);
    } catch {
      // A successful tool result without a readable local file has no attributable snapshot.
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== CODEX_PROVIDER) return;
    if (!hasFetchedQuota) {
      const quota = quotaFromHeaders(event.headers);
      if (quota) setQuotaStatus(ctx, quota);
    }
    requestQuotaRefresh(ctx, quotaSession);
  });

  pi.on("session_start", async (_event, ctx) => {
    setQuotaStatus(ctx, undefined);
    const session = Symbol("bengacoon-job-delivery");
    quotaSession = session;
    quotaRefreshAt = 0;
    hasFetchedQuota = false;
    requestQuotaRefresh(ctx, session);
    deliverySession = session;
    knownJobStates = undefined;
    sessionChanges = new SessionChanges();
    setChangesStatus(ctx);
    manager = undefined;
    showJobDetail = async (id) => {
      if (deliverySession !== session || !manager) return;
      const record = manager.get(id);
      if (!record) {
        ctx.ui.notify(`Job ${id} was not found.`, "error");
        return;
      }
      await showJobs(ctx, formatDetail(record, manager.outputTail(record.id)));
    };
    ctx.ui.notify(LOAD_SIGNAL, "info");
    initialization = initialize(ctx, session).catch((error) => {
      ctx.ui.setStatus("bengacoon-jobs", "jobs: unavailable", {
        lines: [],
        values: { total: "0", active: "0", failed: "0" },
      });
      ctx.ui.notify(`Bengacoon jobs unavailable: ${error.message}`, "error");
      throw error;
    });
    try {
      await initialization;
    } catch {
      // The UI already received a concise error; commands and tools fail closed.
    }
  });

  pi.on("session_shutdown", async () => {
    quotaSession = undefined;
    deliverySession = undefined;
    showJobDetail = undefined;
    knownJobStates = undefined;
    const closingManager = manager;
    manager = undefined;
    if (closingManager) await closingManager.shutdown();
  });

  pi.registerTool({
    name: "bengacoon_report_delivery",
    label: "Report Bengacoon Delivery",
    description: "Report the active Bengacoon work item and its verification progress to the sidebar. Receipt status is read from the staged Git diff and does not authorize commits.",
    parameters: Type.Object({
      workFile: Type.String({ minLength: 1, description: "Path to an active .syra/work Markdown record" }),
      verification: Type.String({ enum: ["pending", "check passed", "prove-red proven"], description: "Progress reported by the workflow" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const work = activeDeliveryWork(ctx.cwd, params.workFile);
      const delivery = { ...work, verification: params.verification, receipt: receiptState(ctx.cwd) };
      setDeliveryStatus(ctx, delivery);
      return { content: [{ type: "text", text: `Reported delivery: ${delivery.nextStep} (${delivery.verification}; receipt ${delivery.receipt}).` }] };
    },
  });

  pi.registerTool({
    name: "bengacoon_start_job",
    label: "Start Bengacoon Job",
    description: "Start a bounded read-only child Bengacoon job in this canonical Git worktree. The child has exactly read, grep, find, and ls; it cannot write, load extensions, save a session, or start Bengacoon jobs.",
    promptSnippet: "Start a bounded read-only background exploration job in the current Git worktree",
    promptGuidelines: [
      "Use bengacoon_start_job only for bounded read-only exploration or verification.",
    ],
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 2000, description: "Bounded read-only task for the child Bengacoon process" }),
      category: Type.Optional(Type.String({ enum: ["exploration", "verification"], description: "Safe fixed title category for the job" })),
      cwd: Type.Optional(Type.String({ description: "Optional canonical worktree root; must exactly match this session's target" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (process.env.BENGACOON_CHILD === "1") {
        throw new Error("Bengacoon child processes cannot start jobs.");
      }
      const jobManager = await activeManager();
      const target = await canonicalWorktree(ctx.cwd, params.cwd);
      if (target !== jobManager.worktreeRoot) {
        throw new Error("Job target does not match this session's canonical worktree.");
      }
      const record = await jobManager.start(validateTask(params.task), params.category);
      return {
        content: [{ type: "text", text: `Started ${record.title} job ${record.id}. Use /jobs ${record.id} for progress.` }],
        details: { id: record.id, category: record.category, status: record.status },
      };
    },
  });

  pi.registerCommand("jobs", {
    description: "List Bengacoon jobs, show /jobs <id>, or cancel /jobs cancel <id>",
    handler: async (args, ctx) => {
      let jobManager;
      try {
        jobManager = await activeManager();
      } catch (error) {
        ctx.ui.notify(`Bengacoon jobs unavailable: ${error.message}`, "error");
        return;
      }

      const input = args.trim();
      if (!input) {
        await showJobs(ctx, formatList(jobManager.list()));
        return;
      }

      const cancel = input.match(/^cancel\s+([0-9a-f-]+)$/i);
      if (cancel) {
        try {
          await jobManager.cancel(cancel[1]);
          await showJobDetail?.(cancel[1]);
        } catch (error) {
          ctx.ui.notify(`Unable to cancel job: ${error.message}`, "error");
        }
        return;
      }

      if (!/^[0-9a-f-]+$/i.test(input)) {
        ctx.ui.notify("Usage: /jobs, /jobs <id>, or /jobs cancel <id>", "error");
        return;
      }
      await showJobDetail?.(input);
    },
  });

  pi.registerCommand("bengacoon-changes", {
    description: "Show changes attributed to successful write and edit tools in this session",
    handler: async (args, ctx) => {
      const path = args.trim();
      const text = path ? sessionChanges.detail(path) : sessionChanges.summary().details.join("\n");
      if (!text) {
        ctx.ui.notify("No changes are attributed to this session.", "info");
        return;
      }
      await showJobs(ctx, text);
    },
  });

  pi.registerCommand("bengacoon-status", {
    description: "Show Bengacoon isolated-profile diagnostics",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${STATUS_SIGNAL}; mode=${ctx.mode}; cwd=${ctx.cwd}`, "info");
    },
  });
}
