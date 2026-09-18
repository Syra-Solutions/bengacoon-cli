import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import bengacoon from "./bengacoon.ts";
import { parseActiveDeliveryWork } from "./delivery.ts";

assert.deepEqual(
  parseActiveDeliveryWork(`# Delivery observability

- [x] completed work
      done: This is complete.

- [ ] show the active delivery unit in the sidebar
      done: the sidebar renders the next work item
`),
  {
    title: "Delivery observability",
    criterion: "the sidebar renders the next work item",
    nextStep: "show the active delivery unit in the sidebar",
  },
);
assert.equal(parseActiveDeliveryWork("# No work\n\n- [x] done\n      done: done\n"), undefined);

const tools = new Map();
bengacoon({
  on() {},
  registerCommand() {},
  registerMessageRenderer() {},
  registerTool(tool) { tools.set(tool.name, tool); },
});
const worktree = mkdtempSync(join(tmpdir(), "bengacoon-delivery-"));
try {
  execFileSync("git", ["init", "--quiet"], { cwd: worktree });
  mkdirSync(join(worktree, ".syra", "work"), { recursive: true });
  writeFileSync(join(worktree, ".syra", "work", "active.md"), `# Delivery observability\n\n- [ ] render the sidebar card\n      done: the active item is visible\n`);
  writeFileSync(join(worktree, "change.md"), "staged delivery change\n");
  execFileSync("git", ["add", "change.md"], { cwd: worktree });
  const diff = execFileSync("git", ["diff", "--cached"], { cwd: worktree, encoding: "utf8" });
  const receipt = execFileSync("git", ["rev-parse", "--git-path", "review-receipt.json"], { cwd: worktree, encoding: "utf8" }).trim();
  mkdirSync(dirname(join(worktree, receipt)), { recursive: true });
  writeFileSync(join(worktree, receipt), JSON.stringify({ diff: createHash("sha256").update(diff).digest("hex") }));
  const statuses = new Map();
  await tools.get("bengacoon_report_delivery").execute("call", { workFile: ".syra/work/active.md", verification: "check passed" }, undefined, undefined, {
    cwd: worktree,
    ui: { setStatus(key, _text, metadata) { statuses.set(key, metadata); } },
  });
  assert.deepEqual(JSON.parse(statuses.get("bengacoon-delivery").values.delivery), {
    title: "Delivery observability",
    criterion: "the active item is visible",
    nextStep: "render the sidebar card",
    verification: "check passed",
    receipt: "matches",
  });
} finally {
  rmSync(worktree, { recursive: true, force: true });
}

console.log("delivery checks passed");
