import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "./runner.ts";
import { normalizeRecords } from "./storage.ts";

// Every spawned -e script carries this marker so a stray process can be found with
// `pgrep -f bengacoon-runtime-probe` if a run is interrupted before cleanup runs.
const PROBE_MARKER = "bengacoon-runtime-probe";

// Mirrors runner.ts's production constants; kept local rather than imported because those
// constants are not exported and must not be changed to make this suite run faster.
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_CONFIRM_MS = 2_000;

class MemoryStore {
  constructor(initialRecords = []) {
    this.initialRecords = initialRecords;
    this.snapshots = [];
  }

  async load() {
    return this.initialRecords;
  }

  async save(records) {
    this.snapshots.push(JSON.parse(JSON.stringify(normalizeRecords(records))));
  }
}

const trackedPids = new Set();

function probeAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

// Waits for the operating system to stop reporting a pid, rather than assuming a duration.
async function waitForExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!probeAlive(pid)) return true;
    await delay(50);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

// Real spawnChild injected through JobManager's existing seam: it ignores the "pi" command
// and arguments JobManager builds, and instead runs the given inline script under the same
// Node binary already running this suite, so no external process (and never `pi`) is needed.
function realSpawnChild(script) {
  return (_command, _args, options) => {
    const child = spawn(process.execPath, ["-e", script], options);
    if (Number.isInteger(child.pid) && child.pid > 0) trackedPids.add(child.pid);
    return child;
  };
}

function waitForStdout(child, pattern, timeoutMs) {
  return new Promise((resolveMatch, rejectMatch) => {
    let buffer = "";
    const timer = setTimeout(() => {
      rejectMatch(new Error(`Timed out waiting for child stdout to match ${pattern}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolveMatch(match);
      }
    });
  });
}

// Polls a JobManager's in-memory output tail for a pattern. Used only to confirm a child's
// SIGTERM handler is actually registered before signalling it, closing a real startup race:
// without this, a fast machine can deliver SIGTERM before the handler is armed, so the child
// dies from the operating system's default action instead of ignoring the signal as intended.
async function waitForTailMatch(manager, id, pattern, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pattern.test(manager.outputTail(id))) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for job ${id} output to match ${pattern}`);
}

function onceClose(child, timeoutMs) {
  return new Promise((resolveClose) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveClose(false);
    }, timeoutMs);
    child.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClose(true);
    });
  });
}

function cleanupTrackedProcesses() {
  for (const pid of trackedPids) {
    // Signal the process group first when this pid leads one, so cleanup cannot strand
    // a process spawned underneath it. The direct signal below covers every other case.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Not a group leader, or already gone; the direct signal below is the fallback.
    }
    if (probeAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best-effort cleanup; nothing further to do if the process is already gone.
      }
    }
  }
}

async function runScenarios() {
  const root = await realpath(process.cwd());

  // (a) Happy path with a real process: prints a FINAL_RESULT line and exits 0.
  console.log("scenario (a): happy path with a real process");
  const happyScript = `// ${PROBE_MARKER}
console.log("bengacoon runtime probe: happy path output");
console.log("FINAL_RESULT: Verified real process happy path.");
process.exit(0);
`;
  const happyEvents = [];
  const happyTerminal = deferred();
  const happyManager = new JobManager(
    new MemoryStore(),
    root,
    "/safe/profile",
    undefined,
    realSpawnChild(happyScript),
    (record) => {
      happyEvents.push(record);
      happyTerminal.resolve(record);
    },
  );
  await happyManager.initialize();
  const happyRecord = await happyManager.start("verify a real process completes normally");
  const happyPid = happyRecord.pid;
  assert.equal(Number.isInteger(happyPid) && happyPid > 0, true);
  assert.equal(probeAlive(happyPid), true);
  await withTimeout(happyTerminal.promise, 15_000, "happy-path job did not reach a terminal state in time");
  assert.equal(happyRecord.status, "completed");
  assert.equal(happyRecord.exitCode, 0);
  assert.equal(happyRecord.pid, undefined);
  assert.equal(happyEvents.at(-1).finalResult, "Verified real process happy path.");
  console.log("scenario (a) passed");

  // (b) Real SIGTERM-responsive cancel: the child has no SIGTERM handler, so the operating
  // system's default action terminates it as soon as the first signal is delivered.
  console.log("scenario (b): real SIGTERM-responsive cancel");
  const cancelScript = `// ${PROBE_MARKER}
setInterval(() => {}, 1000);
`;
  const cancelManager = new JobManager(
    new MemoryStore(),
    root,
    "/safe/profile",
    undefined,
    realSpawnChild(cancelScript),
    undefined,
  );
  await cancelManager.initialize();
  const cancelRecord = await cancelManager.start("verify a real SIGTERM-responsive cancel");
  const cancelPid = cancelRecord.pid;
  assert.equal(Number.isInteger(cancelPid) && cancelPid > 0, true);
  let cancelResult;
  try {
    cancelResult = await withTimeout(
      cancelManager.cancel(cancelRecord.id),
      15_000,
      "cancel of a SIGTERM-responsive child did not resolve in time",
    );
  } catch (error) {
    assert.fail(`expected cancel to resolve without throwing, but it threw: ${error.message}`);
  }
  assert.equal(cancelResult.status, "cancelled");
  assert.throws(
    () => process.kill(cancelPid, 0),
    (error) => error && error.code === "ESRCH",
    "expected the cancelled process to be confirmed gone (ESRCH) after the close event",
  );
  console.log("scenario (b) passed");

  // (c) SIGTERM-ignoring child forces real SIGKILL escalation. This has never been exercised
  // against a real process before: the child installs a no-op SIGTERM handler, so cancel()
  // must wait out TERMINATION_GRACE_MS and escalate to SIGKILL, which cannot be ignored.
  console.log("scenario (c): SIGTERM-ignoring child forces real SIGKILL escalation");
  const stubbornScript = `// ${PROBE_MARKER}
process.on("SIGTERM", () => {});
console.log("SIGTERM_HANDLER_READY");
setInterval(() => {}, 1000);
`;
  const stubbornManager = new JobManager(
    new MemoryStore(),
    root,
    "/safe/profile",
    undefined,
    realSpawnChild(stubbornScript),
    undefined,
  );
  await stubbornManager.initialize();
  const stubbornRecord = await stubbornManager.start("verify SIGKILL escalation against a SIGTERM-ignoring child");
  const stubbornPid = stubbornRecord.pid;
  assert.equal(Number.isInteger(stubbornPid) && stubbornPid > 0, true);
  // Wait for the child to confirm its SIGTERM handler is armed before signalling it; otherwise
  // a fast machine can send SIGTERM before the handler is registered, and the child would die
  // from the default action instead of ignoring the signal as this scenario requires.
  await waitForTailMatch(stubbornManager, stubbornRecord.id, /SIGTERM_HANDLER_READY/, 5_000);

  const escalationStart = Date.now();
  let stubbornResult;
  try {
    stubbornResult = await withTimeout(
      stubbornManager.cancel(stubbornRecord.id),
      TERMINATION_GRACE_MS + TERMINATION_CONFIRM_MS + 10_000,
      "cancel of a SIGTERM-ignoring child did not resolve in time",
    );
  } catch (error) {
    assert.fail(`expected escalation to SIGKILL to confirm termination, but cancel threw: ${error.message}`);
  }
  const escalationElapsedMs = Date.now() - escalationStart;
  assert.ok(
    escalationElapsedMs >= TERMINATION_GRACE_MS,
    `expected SIGKILL escalation to take at least ${TERMINATION_GRACE_MS}ms, measured ${escalationElapsedMs}ms`,
  );
  assert.equal(stubbornResult.status, "cancelled");
  assert.throws(
    () => process.kill(stubbornPid, 0),
    (error) => error && error.code === "ESRCH",
    "expected the SIGKILL-terminated process to be confirmed gone (ESRCH)",
  );
  console.log(`scenario (c) passed; measured SIGTERM-to-confirmed-termination elapsed time: ${escalationElapsedMs}ms`);

  // (d) probeOrphan against real pids: true for this live test process, false once a real
  // child has fully exited.
  console.log("scenario (d): probeOrphan against real pids");
  assert.equal(stubbornManager.probeOrphan(process.pid), true);

  const exitScript = `// ${PROBE_MARKER}
process.exit(0);
`;
  const exitTerminal = deferred();
  const exitManager = new JobManager(
    new MemoryStore(),
    root,
    "/safe/profile",
    undefined,
    realSpawnChild(exitScript),
    (record) => exitTerminal.resolve(record),
  );
  await exitManager.initialize();
  const exitRecord = await exitManager.start("verify probeOrphan reports a fully exited child as gone");
  const exitPid = exitRecord.pid;
  assert.equal(Number.isInteger(exitPid) && exitPid > 0, true);
  await withTimeout(exitTerminal.promise, 15_000, "quick-exit job did not reach a terminal state in time");
  assert.equal(exitManager.probeOrphan(exitPid), false);
  console.log("scenario (d) passed");

  console.log("scenario (e): cancelling a job also terminates a grandchild");
  // The grandchild announces itself only once its SIGTERM handler is installed. Without that
  // the test races: a grandchild signalled before the handler is armed dies from the default
  // action and the scenario passes for the wrong reason, which is how a real gap in the
  // termination path sat behind an intermittently green assertion.
  const grandchildReadyFile = join(tmpdir(), `bengacoon-grandchild-ready-${process.pid}`);
  const grandchildScript = `// ${PROBE_MARKER}
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(grandchildReadyFile)}, "ready");
setInterval(() => {}, 1000);
`;
  const parentOfGrandchildScript = `// ${PROBE_MARKER}
const { spawn } = require("node:child_process");
const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
process.stdout.write("GRANDCHILD_PID:" + grandchild.pid + "\\n");
setInterval(() => {}, 1000);
`;
  rmSync(grandchildReadyFile, { force: true });
  const grandchildManager = new JobManager(
    new MemoryStore(),
    root,
    "/safe/profile",
    undefined,
    realSpawnChild(parentOfGrandchildScript),
    undefined,
  );
  await grandchildManager.initialize();
  const grandchildRecord = await grandchildManager.start("verify a grandchild does not outlive its job");
  trackedPids.add(grandchildRecord.pid);
  await waitForTailMatch(grandchildManager, grandchildRecord.id, /GRANDCHILD_PID:(\d+)/, 10_000);
  const managedGrandchildPid = Number(
    grandchildManager.outputTail(grandchildRecord.id).match(/GRANDCHILD_PID:(\d+)/)[1],
  );
  trackedPids.add(managedGrandchildPid);
  assert.equal(probeAlive(managedGrandchildPid), true, "grandchild should be running before cancellation");
  const readyStart = Date.now();
  while (!existsSync(grandchildReadyFile) && Date.now() - readyStart < 10_000) await delay(20);
  assert.equal(existsSync(grandchildReadyFile), true, "grandchild never armed its SIGTERM handler");

  await withTimeout(grandchildManager.cancel(grandchildRecord.id), 20_000, "grandchild job cancel did not settle");
  assert.equal(grandchildRecord.status, "cancelled");
  // The close event only confirms the direct child. Give the group signal a moment to land
  // on the grandchild before asserting the operating system considers it gone.
  // The close event confirms the direct child only. Poll for the grandchild rather than
  // sleeping a fixed amount: how long the operating system takes to reap it varies with load,
  // and a fixed wait turns a real assertion into a flaky one.
  const grandchildGone = await waitForExit(managedGrandchildPid, 10_000);
  assert.equal(
    grandchildGone,
    true,
    "grandchild outlived its cancelled job: process-group termination did not reach it",
  );
  console.log("scenario (e) passed");

  // (f) MEASUREMENT, NOT ASSERTION. Records the difference the process-group signal makes,
  // so the reason terminateAndWait signals a group stays visible rather than folklore. It
  // never fails the suite: every step is wrapped so an error is printed as a diagnostic.
  console.log("scenario (f): diagnostic measurement of grandchild survival (not an assertion)");
  const groupChildScript = `// ${PROBE_MARKER}
const { spawn } = require("node:child_process");
const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
process.stdout.write("GRANDCHILD_PID:" + grandchild.pid + "\\n");
setInterval(() => {}, 1000);
`;

  async function directKillExperiment() {
    const child = spawn(process.execPath, ["-e", groupChildScript], { stdio: ["ignore", "pipe", "ignore"] });
    trackedPids.add(child.pid);
    const [, grandchildPidText] = await waitForStdout(child, /GRANDCHILD_PID:(\d+)/, 5_000);
    const grandchildPid = Number(grandchildPidText);
    trackedPids.add(grandchildPid);
    await delay(150);

    try {
      child.kill("SIGTERM");
    } catch {
      // Diagnostic only; a failed signal delivery is reported as "survived" below.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Diagnostic only.
    }
    await onceClose(child, 2_000);
    await delay(150);

    return { grandchildPid, survived: probeAlive(grandchildPid) };
  }

  async function groupKillExperiment() {
    const child = spawn(process.execPath, ["-e", groupChildScript], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    trackedPids.add(child.pid);
    const [, grandchildPidText] = await waitForStdout(child, /GRANDCHILD_PID:(\d+)/, 5_000);
    const grandchildPid = Number(grandchildPidText);
    trackedPids.add(grandchildPid);
    await delay(150);

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Diagnostic only; a failed signal delivery is reported as "survived" below.
    }
    await onceClose(child, 2_000);
    await delay(150);

    return { grandchildPid, survived: probeAlive(grandchildPid) };
  }

  let directSurvived = "unknown (experiment error)";
  try {
    directSurvived = (await directKillExperiment()).survived;
  } catch (error) {
    console.log(`direct-kill diagnostic experiment failed: ${error?.message ?? error}`);
  }

  let groupSurvived = "unknown (experiment error)";
  try {
    groupSurvived = (await groupKillExperiment()).survived;
  } catch (error) {
    console.log(`group-kill diagnostic experiment failed: ${error?.message ?? error}`);
  }

  console.log(`grandchild survived (direct kill): ${directSurvived}`);
  console.log(`grandchild survived (group kill): ${groupSurvived}`);
}

try {
  await runScenarios();
} finally {
  cleanupTrackedProcesses();
}

console.log("background-job runtime checks passed");
