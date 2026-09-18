import assert from "node:assert/strict";
import { reviewCardText, workflowNoticeText } from "./workflow-ui.ts";

assert.deepEqual(
  workflowNoticeText("warning", "Review gate not enforced: hook is unavailable."),
  [
    "⚙ Bengacoon workflow",
    "Status: warning",
    "Review gate not enforced: hook is unavailable.",
  ],
);
assert.deepEqual(
  workflowNoticeText("error", "Syra could not restore the configured model."),
  [
    "⚙ Bengacoon workflow",
    "Status: error",
    "Syra could not restore the configured model.",
  ],
);
assert.deepEqual(
  reviewCardText({ reviewer: "security", state: "completed", verdict: "PASS", findings: [] }),
  ["◈ Security review", "Status: completed", "Verdict: PASS", "Findings: 0"],
);
