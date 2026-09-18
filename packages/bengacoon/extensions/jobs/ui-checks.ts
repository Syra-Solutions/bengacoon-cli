import assert from "node:assert/strict";
import { jobStatusUpdates } from "./format.ts";
import { jobCardText } from "./ui.ts";

assert.deepEqual(
  jobCardText(
    { category: "exploration", status: "running" },
    "Inspecting the repository.",
    false,
  ),
  [
    "↻ Repository exploration",
    "Status: running",
    "Inspecting the repository.",
    "Status updates appear in this transcript.",
  ],
);
assert.deepEqual(
  jobCardText(
    { category: "verification", status: "completed" },
    "Checks passed.",
    true,
  ),
  [
    "↻ Repository verification",
    "Status: completed",
    "Checks passed.",
    "Click to open job details",
  ],
);

const knownStates = new Map([["existing", "queued"]]);
assert.deepEqual(
  jobStatusUpdates(
    [
      { id: "existing", status: "running" },
      { id: "terminal", status: "completed" },
      { id: "new", status: "queued" },
    ],
    knownStates,
  ),
  [
    { id: "existing", status: "running" },
    { id: "new", status: "queued" },
  ],
);
assert.deepEqual([...knownStates], [["existing", "running"], ["terminal", "completed"], ["new", "queued"]]);
