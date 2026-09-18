import { Box, Text } from "@earendil-works/pi-tui";

export function workflowNoticeText(type, message) {
  return ["⚙ Bengacoon workflow", `Status: ${type}`, message];
}

function noticeColor(type) {
  if (type === "error") return "error";
  if (type === "warning") return "warning";
  return "accent";
}

export class WorkflowNoticeCard {
  constructor(type, message, theme, outputPad) {
    const [title, status, body] = workflowNoticeText(type, message);
    this.box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    this.box.addChild(new Text(
      [
        theme.fg("accent", theme.bold(title)),
        theme.fg(noticeColor(type), status),
        theme.fg("text", body),
      ].join("\n"),
      0,
      0,
    ));
  }

  render(width) {
    return this.box.render(width);
  }

  invalidate() {
    this.box.invalidate();
  }
}
