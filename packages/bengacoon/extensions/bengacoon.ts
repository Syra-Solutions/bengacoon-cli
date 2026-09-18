import { Type } from "typebox";
import { formatTerminalCompletion, JobManager, validateTask } from "./jobs/runner.ts";
import { canonicalWorktree, JobStore, resolveProfileDir } from "./jobs/storage.ts";
import { formatDetail, formatList, jobStatusSnapshot, statusText } from "./jobs/format.ts";
import { CompletionCard, JobsView } from "./jobs/ui.ts";
import { readModelAssignments, resolveBengacoonAgentDir } from "./models/config.ts";
import { parseCodexQuotaHeaders } from "./quota.ts";

const LOAD_SIGNAL = "BENGACOON_EXTENSION_LOADED";
const STATUS_SIGNAL = "BENGACOON_STATUS: extension=loaded";

export default function bengacoon(pi) {
  let manager;
  let initialization;
  let deliverySession;
  let showJobDetail;

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

  const setQuotaStatus = (ctx, quota) => {
    const daily = quota?.dailyRemainingPercent;
    const weekly = quota?.weeklyRemainingPercent;
    ctx.ui.setStatus(
      "bengacoon-quota",
      `quota: daily ${daily === undefined ? "Unavailable" : `${daily}% remaining`}, weekly ${weekly === undefined ? "Unavailable" : `${weekly}% remaining`}`,
      {
        values: {
          ...(daily === undefined ? {} : { dailyRemainingPercent: String(daily) }),
          ...(weekly === undefined ? {} : { weeklyRemainingPercent: String(weekly) }),
        },
      },
    );
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
      (records) => setJobStatus(ctx, records),
      undefined,
      (record) => {
        if (deliverySession !== session) return;
        try {
          pi.sendMessage({
            customType: "bengacoon-job-completion",
            content: formatTerminalCompletion(record),
            display: true,
            details: {
              id: record.id,
              category: record.category,
              status: record.status,
              ...(record.finalResult ? { finalResult: record.finalResult } : {}),
            },
          }, { deliverAs: "followUp", triggerTurn: false });
        } catch {
          // Completion delivery is best-effort and must not alter the job record.
        }
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

  pi.registerMessageRenderer("bengacoon-job-completion", (message, { outputPad }, theme) => {
    const id = typeof message.details?.id === "string" ? message.details.id : undefined;
    return new CompletionCard(message.content, theme, outputPad, async () => {
      if (id) await showJobDetail?.(id);
    });
  });

  pi.on("after_provider_response", (event, ctx) => {
    const quota = parseCodexQuotaHeaders(event.headers);
    if (quota) setQuotaStatus(ctx, quota);
  });

  pi.on("session_start", async (_event, ctx) => {
    setQuotaStatus(ctx, undefined);
    const session = Symbol("bengacoon-job-delivery");
    deliverySession = session;
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
    deliverySession = undefined;
    showJobDetail = undefined;
    const closingManager = manager;
    manager = undefined;
    if (closingManager) await closingManager.shutdown();
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

  pi.registerCommand("bengacoon-status", {
    description: "Show Bengacoon isolated-profile diagnostics",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${STATUS_SIGNAL}; mode=${ctx.mode}; cwd=${ctx.cwd}`, "info");
    },
  });
}
