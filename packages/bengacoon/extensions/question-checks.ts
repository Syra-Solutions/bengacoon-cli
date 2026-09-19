import assert from "node:assert/strict";
import bengacoon from "./bengacoon.ts";

const tools = new Map();
bengacoon({
  on() {},
  sendMessage() {},
  registerCommand() {},
  registerMessageRenderer() {},
  registerTool(tool) { tools.set(tool.name, tool); },
});

const questionTool = tools.get("bengacoon_ask_user");
assert.ok(questionTool, "bengacoon_ask_user should be registered");
assert.match(questionTool.promptGuidelines.join("\n"), /Use bengacoon_ask_user/);

{
  const selectedOptions = [];
  const result = await questionTool.execute("call", {
    question: "Where should this land?",
    options: ["Create a new branch", "Use the current branch"],
    recommendedIndex: 0,
  }, undefined, undefined, {
    hasUI: true,
    ui: {
      async select(title, options) {
        assert.equal(title, "Where should this land?");
        selectedOptions.push(...options);
        return options[0];
      },
      async input() {
        throw new Error("input should not be requested for a suggested option");
      },
    },
  });
  assert.deepEqual(selectedOptions, [
    "1. Create a new branch (recommended)",
    "2. Use the current branch",
    "3. Other: type a different answer",
  ]);
  assert.deepEqual(result.details, { answer: "Create a new branch", source: "option", cancelled: false });
  assert.equal(result.content[0].text, "User selected: Create a new branch");
}

{
  const result = await questionTool.execute("call", {
    question: "Choose reviewer",
    options: ["No additional reviewer"],
  }, undefined, undefined, {
    hasUI: true,
    ui: {
      async select(_title, options) {
        return options[1];
      },
      async input(title, placeholder) {
        assert.equal(title, "Other answer");
        assert.equal(placeholder, "Type a different answer");
        return "Run security too";
      },
    },
  });
  assert.deepEqual(result.details, { answer: "Run security too", source: "other", cancelled: false });
}

{
  const result = await questionTool.execute("call", {
    question: "Choose duplicate",
    options: ["Same", "Same"],
  }, undefined, undefined, {
    hasUI: true,
    ui: {
      async select(_title, options) {
        assert.deepEqual(options, ["1. Same", "2. Same", "3. Other: type a different answer"]);
        return options[1];
      },
      async input() {
        throw new Error("input should not be requested for a suggested option");
      },
    },
  });
  assert.deepEqual(result.details, { answer: "Same", source: "option", cancelled: false });
}

{
  const result = await questionTool.execute("call", {
    question: "Continue?",
    options: ["Yes", "No"],
  }, undefined, undefined, {
    hasUI: true,
    ui: {
      async select() {
        return undefined;
      },
      async input() {
        throw new Error("input should not be requested after cancel");
      },
    },
  });
  assert.deepEqual(result.details, { answer: undefined, source: "cancelled", cancelled: true });
  assert.equal(result.content[0].text, "User cancelled the decision panel.");
}

console.log("question checks passed");
