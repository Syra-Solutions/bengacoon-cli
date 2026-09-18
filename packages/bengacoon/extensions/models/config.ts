import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL_ASSIGNMENTS_FILE = "syra-models.json";
export const MODEL_ASSIGNMENTS_VERSION = 1;
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function resolveBengacoonAgentDir(environment = process.env, home = homedir()) {
  return environment.BENGACOON_PROFILE_DIR ?? environment.BENGACOON_CODING_AGENT_DIR ?? join(home, ".bengacoon", "agent");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTarget(target, supportedTargets) {
  if (typeof target !== "string" || !supportedTargets.has(target)) {
    throw new Error(`Unsupported model-assignment target: ${String(target)}`);
  }
  return target;
}

function validateAssignment(value) {
  if (!isPlainObject(value)) throw new Error("A model assignment must be an object.");
  const { model, thinking } = value;
  if (typeof model !== "string" || !/^[^/\u0000\s]+\/[^\u0000\s]+$/.test(model)) {
    throw new Error("A model assignment must use provider/model format.");
  }
  if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking)) {
    throw new Error("A model assignment must use a supported thinking level.");
  }
  return { model, thinking };
}

export function normalizeModelAssignments(value, supportedTargets) {
  if (!isPlainObject(value)) throw new Error("Model assignments must be an object.");
  const normalized = {};
  for (const [target, assignment] of Object.entries(value)) {
    normalized[validateTarget(target, supportedTargets)] = validateAssignment(assignment);
  }
  return normalized;
}

export function resolveModelAssignment(assignments, target, active) {
  const assignment = assignments?.[target];
  return assignment ? { ...assignment } : { ...active };
}

export function skillTargetFromInput(input) {
  const match = typeof input === "string" ? input.match(/^\/skill:([^\s]+)(?:\s|$)/) : undefined;
  return match ? `skill:${match[1]}` : undefined;
}

function modelAssignmentsPath(profileDir) {
  if (typeof profileDir !== "string" || !profileDir) throw new Error("Bengacoon profile directory is unavailable.");
  return join(profileDir, MODEL_ASSIGNMENTS_FILE);
}

export async function readModelAssignments(profileDir, supportedTargets) {
  let contents;
  try {
    contents = await readFile(modelAssignmentsPath(profileDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Syra model assignments contain invalid JSON.");
  }
  if (!isPlainObject(parsed) || parsed.version !== MODEL_ASSIGNMENTS_VERSION) {
    throw new Error(`Syra model assignments must use version ${MODEL_ASSIGNMENTS_VERSION}.`);
  }
  return normalizeModelAssignments(parsed.targets, supportedTargets);
}

export async function writeModelAssignments(profileDir, assignments, supportedTargets) {
  const targets = normalizeModelAssignments(assignments, supportedTargets);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const destination = modelAssignmentsPath(profileDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ version: MODEL_ASSIGNMENTS_VERSION, targets }, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    await handle?.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
