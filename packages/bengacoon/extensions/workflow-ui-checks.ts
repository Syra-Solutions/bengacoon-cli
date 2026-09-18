import assert from "node:assert/strict";
import { workflowNoticeText } from "./workflow-ui.ts";

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
