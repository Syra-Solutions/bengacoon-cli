import assert from "node:assert/strict";
import { SessionChanges } from "./changes.ts";

const changes = new SessionChanges();
changes.captureBefore("src/example.ts", "const value = 1;\n");
changes.captureAfter("src/example.ts", "const value = 2;\nconst doubled = value * 2;\n");

assert.deepEqual(changes.summary(), {
  total: 1,
  added: 1,
  removed: 0,
  details: ["src/example.ts +1 -0"],
});
assert.match(changes.detail("src/example.ts"), /--- src\/example.ts/);
assert.match(changes.detail("src/example.ts"), /\+const doubled = value \* 2;/);

console.log("session changes checks passed");
