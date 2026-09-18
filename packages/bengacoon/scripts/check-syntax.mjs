import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const roots = ["extensions", "scripts"];

function collectSourceFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"))) {
      files.push(path);
    }
  }
  return files;
}

const files = roots.flatMap(collectSourceFiles).sort();
let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  } catch {
    failed = true;
  }
}

if (failed) {
  console.error("Syntax check failed.");
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} file(s).`);
