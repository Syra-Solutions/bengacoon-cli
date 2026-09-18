import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const WORK_DIRECTORY = ".syra/work";
const STATE_FILE = "bengacoon-delivery.json";

function deliveryStatePath(cwd) {
  return resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", STATE_FILE], { cwd, encoding: "utf8", stdio: "pipe" }).trim());
}

export function loadDeliveryState(cwd) {
  try {
    const state = JSON.parse(readFileSync(deliveryStatePath(cwd), "utf8"));
    if (
      typeof state?.title !== "string" ||
      typeof state?.criterion !== "string" ||
      typeof state?.nextStep !== "string" ||
      typeof state?.verification !== "string" ||
      typeof state?.commitBase !== "string" ||
      !/^[a-f0-9]{64}$/.test(state?.commitDiff) ||
      !["active", "committed", "blocked", "awaiting-human"].includes(state?.state)
    )
      return undefined;
    return state;
  } catch {
    return undefined;
  }
}

export function restoreDeliveryState(cwd) {
  const state = loadDeliveryState(cwd);
  return state ? { ...state, receipt: receiptState(cwd) } : undefined;
}

export function saveDeliveryState(cwd, state) {
  const path = deliveryStatePath(cwd);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export function parseActiveDeliveryWork(contents) {
  const lines = String(contents).split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim();
  if (!title) return undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index].match(/^\s*- \[ \] (.+)$/);
    if (!item) continue;
    const criterion = lines.slice(index + 1).find((line) => /^\s+done:\s+/.test(line));
    if (!criterion) return undefined;
    return {
      title,
      criterion: criterion.replace(/^\s+done:\s+/, "").trim(),
      nextStep: item[1].trim(),
    };
  }
  return undefined;
}

export function activeDeliveryWork(cwd, workFile) {
  const root = resolve(cwd);
  const file = resolve(root, workFile);
  const workRoot = resolve(root, WORK_DIRECTORY);
  if (relative(workRoot, file).startsWith("..") || !relative(workRoot, file)) {
    throw new Error("Delivery work records must be files inside .syra/work.");
  }
  if (!existsSync(file)) throw new Error(`Delivery work record was not found: ${workFile}`);
  const delivery = parseActiveDeliveryWork(readFileSync(file, "utf8"));
  if (!delivery) throw new Error(`Delivery work record has no unfinished item: ${workFile}`);
  return delivery;
}

function hashDiff(cwd, args) {
  try {
    const diff = execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return diff.trim() ? createHash("sha256").update(diff).digest("hex") : undefined;
  } catch {
    return undefined;
  }
}

export function stagedDiffHash(cwd) {
  return hashDiff(cwd, ["diff", "--cached"]);
}

export function headCommitDiffHash(cwd) {
  return hashDiff(cwd, ["diff", "HEAD^", "HEAD"]);
}

export function headCommitParent(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD^"], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return undefined;
  }
}

export function receiptState(cwd) {
  try {
    const receipt = resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", "review-receipt.json"], { cwd, encoding: "utf8", stdio: "pipe" }).trim());
    if (!existsSync(receipt)) return "missing";
    const diff = execFileSync("git", ["diff", "--cached"], { cwd, encoding: "utf8", stdio: "pipe" });
    if (!diff.trim()) return "missing";
    const recorded = JSON.parse(readFileSync(receipt, "utf8"));
    return recorded?.diff === createHash("sha256").update(diff).digest("hex") ? "matches" : "stale";
  } catch {
    return "unavailable";
  }
}
