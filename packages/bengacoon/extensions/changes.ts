const MAX_FILES = 50;

function lines(value) {
  return value === "" ? 0 : value.split("\n").length - Number(value.endsWith("\n"));
}

export class SessionChanges {
  constructor() {
    this.files = new Map();
  }

  captureBefore(path, contents) {
    if (this.files.has(path) || this.files.size >= MAX_FILES) return;
    this.files.set(path, { before: contents, after: contents });
  }

  captureAfter(path, contents) {
    const file = this.files.get(path);
    if (!file) return;
    file.after = contents;
  }

  summary() {
    const details = [];
    let added = 0;
    let removed = 0;
    for (const [path, file] of this.files) {
      const delta = lines(file.after) - lines(file.before);
      const fileAdded = Math.max(0, delta);
      const fileRemoved = Math.max(0, -delta);
      added += fileAdded;
      removed += fileRemoved;
      details.push(`${path} +${fileAdded} -${fileRemoved}`);
    }
    return { total: this.files.size, added, removed, details };
  }

  detail(path) {
    const file = this.files.get(path);
    if (!file) return undefined;
    return [`--- ${path}`, `+++ ${path}`, ...file.before.split("\n").map((line) => `-${line}`), ...file.after.split("\n").map((line) => `+${line}`)].join("\n");
  }
}
