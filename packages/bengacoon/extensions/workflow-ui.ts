import { Box, Text } from "@earendil-works/pi-tui";

export function workflowNoticeText(type, message) {
  return ["⚙ Bengacoon workflow", `Status: ${type}`, message];
}

export function reviewCardText(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const title = `${String(review?.reviewer ?? "unknown").slice(0, 1).toUpperCase()}${String(review?.reviewer ?? "unknown").slice(1)} review`;
  return [
    `◈ ${title}`,
    `Status: ${review?.state ?? "unknown"}`,
    ...(review?.verdict ? [`Verdict: ${review.verdict}`] : []),
    ...(review?.state === "completed" ? [`Findings: ${findings.length}`, ...findings] : []),
  ];
}

function noticeColor(type) {
  if (type === "error") return "error";
  if (type === "warning") return "warning";
  return "accent";
}

export class ReviewCard {
  constructor(review, theme, outputPad) {
    const lines = reviewCardText(review);
    this.box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    this.box.addChild(new Text(
      [
        theme.fg("accent", theme.bold(lines[0])),
        theme.fg(review?.state === "completed" && review?.verdict !== "PASS" ? "warning" : "accent", lines[1]),
        ...lines.slice(2).map((line) => theme.fg("text", line)),
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
