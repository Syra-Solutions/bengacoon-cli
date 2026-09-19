import { Type } from "typebox";

const OTHER_DECISION_LABEL = "Other: type a different answer";

export function registerDecisionTool(pi) {
  pi.registerTool({
    name: "bengacoon_ask_user",
    label: "Ask User Decision",
    description: "Ask the user for a workflow decision through a selectable UI panel and return the selected or free-form answer.",
    promptSnippet: "Ask the user for a decision through a selectable panel with an Other free-form option",
    promptGuidelines: [
      "Use bengacoon_ask_user whenever you need the user to decide something; do not present decision menus as normal chat text.",
      "Provide concise suggested answers, mark the recommended answer with recommendedIndex when one exists, and rely on the tool's Other option for free-form input.",
    ],
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 500, description: "Decision question shown as the panel title" }),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 3, description: "Suggested answers; the tool adds Other automatically" }),
      recommendedIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 2, description: "Zero-based index of the recommended suggested answer" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("A decision panel requires interactive UI.");
      if (params.recommendedIndex !== undefined && params.recommendedIndex >= params.options.length) {
        throw new Error("recommendedIndex must point to one of the suggested options.");
      }
      const suggestedLabels = params.options.map((option, index) => {
        const recommendation = index === params.recommendedIndex ? " (recommended)" : "";
        return `${index + 1}. ${option}${recommendation}`;
      });
      const otherLabel = `${params.options.length + 1}. ${OTHER_DECISION_LABEL}`;
      const selected = await ctx.ui.select(params.question, [...suggestedLabels, otherLabel]);
      if (!selected) {
        return {
          content: [{ type: "text", text: "User cancelled the decision panel." }],
          details: { answer: undefined, source: "cancelled", cancelled: true },
        };
      }
      if (selected === otherLabel) {
        const answer = await ctx.ui.input("Other answer", "Type a different answer");
        if (!answer) {
          return {
            content: [{ type: "text", text: "User cancelled the free-form answer." }],
            details: { answer: undefined, source: "cancelled", cancelled: true },
          };
        }
        return {
          content: [{ type: "text", text: `User answered: ${answer}` }],
          details: { answer, source: "other", cancelled: false },
        };
      }
      const selectedIndex = suggestedLabels.indexOf(selected);
      if (selectedIndex === -1) throw new Error("Selected option was not part of the decision panel.");
      const answer = params.options[selectedIndex];
      return {
        content: [{ type: "text", text: `User selected: ${answer}` }],
        details: { answer, source: "option", cancelled: false },
      };
    },
  });
}
