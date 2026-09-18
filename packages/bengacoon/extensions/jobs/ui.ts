import { Box, Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { jobTitleForCategory } from "./storage.ts";

export { formatDetail, formatList, statusText } from "./format.ts";

export function jobCardText(record, summary, terminal) {
  return [
    `↻ ${jobTitleForCategory(record?.category)}`,
    `Status: ${record?.status ?? "unknown"}`,
    summary,
    terminal ? "Click to open job details" : "Status updates appear in this transcript.",
  ];
}

function statusColor(status) {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled" || status === "interrupted" || status === "termination_unconfirmed") return "error";
  return "accent";
}

export class JobCard {
  constructor(record, summary, terminal, theme, outputPad, onOpen) {
    this.onOpen = onOpen;
    const [title, status, body, hint] = jobCardText(record, summary, terminal);
    this.box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    this.box.addChild(new Text(
      [
        theme.fg("accent", theme.bold(title)),
        theme.fg(statusColor(record?.status), status),
        theme.fg("text", body),
        theme.fg("dim", hint),
      ].join("\n"),
      0,
      0,
    ));
  }

  handleMouse(event) {
    if (!this.onOpen || event.type !== "click" || event.button !== "left") return undefined;
    void this.onOpen();
    return { handled: true, focus: false };
  }

  render(width) {
    return this.box.render(width);
  }

  invalidate() {
    this.box.invalidate();
  }
}

export class JobsView {
  constructor(text, theme, onClose) {
    this.text = text;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) {
      this.onClose();
    }
  }

  render(width) {
    const lines = [];
    for (const line of this.text.split("\n")) {
      lines.push(...wrapTextWithAnsi(line, Math.max(1, width - 2)));
    }
    lines.push(this.theme.fg("dim", "Press Enter or Escape to close"));
    return lines.map((line) => truncateToWidth(` ${line}`, width));
  }

  invalidate() {}
}
