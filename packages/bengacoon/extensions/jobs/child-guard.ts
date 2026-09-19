import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function toolPath(input) {
  if (!input || typeof input.path !== "string" || !input.path) return ".";
  return input.path.startsWith("@") ? input.path.slice(1) : input.path;
}

async function existingAncestor(path) {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

// Pi expands a leading "~" inside the tool, after this hook has already decided. Checking the
// literal string approves "<root>/~/..." — a path inside the root that does not exist — while
// the tool then reads the real home directory. Expand it here so the guard judges the path
// that is actually read. A "~user" form cannot be resolved reliably, so it is refused outright
// rather than guessed at.
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path.startsWith("~")) return undefined;
  return path;
}

export async function isGuardedPathInsideRoot(root, requestedPath) {
  if (typeof root !== "string" || !root || !isAbsolute(root)) return false;
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return false;
  }
  const requested = expandHome(toolPath({ path: requestedPath }));
  if (requested === undefined) return false;
  const resolved = resolve(canonicalRoot, requested);
  if (!isInside(canonicalRoot, resolved)) return false;
  const canonicalAncestor = await existingAncestor(resolved);
  return Boolean(canonicalAncestor && isInside(canonicalRoot, canonicalAncestor));
}

// Announced on the child's stderr so the parent can tell a blocked job from a finished one.
// Terminating the session makes Pi exit 0 without writing to either stream, which is
// indistinguishable from a job that simply produced no final result. The runner matches this
// marker in the captured output tail; it is the contract between the two processes.
export const GUARD_BLOCKED_MARKER = "BENGACOON_GUARD_BLOCKED";

const BLOCK_REASON = "Bengacoon child jobs may access only paths inside their canonical target repository.";

export default function childRepositoryGuard(pi) {
  const targetRoot = process.env.BENGACOON_TARGET_ROOT;
  if (typeof targetRoot !== "string" || !targetRoot || !isAbsolute(targetRoot)) {
    throw new Error("Bengacoon child guard requires a canonical target repository.");
  }

  pi.on("tool_call", async (event) => {
    if (!["read", "grep", "find", "ls"].includes(event.toolName)) return;
    if (!(await isGuardedPathInsideRoot(targetRoot, event.input?.path))) {
      // The requested path names what was refused, for the in-memory job detail view only.
      // It is never persisted: the parent stores no child output in a job record.
      process.stderr.write(
        `${GUARD_BLOCKED_MARKER}: ${BLOCK_REASON} Refused ${event.toolName} of ${toolPath(event.input)}\n`,
      );
      return {
        block: true,
        reason: BLOCK_REASON,
        terminate: true,
      };
    }
  });
}
