import { execFileSync } from "node:child_process";
function gitOutput(cwd, args) {
	try {
		return { output: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) };
	} catch {
		return { output: "", unavailable: true };
	}
}

function parseNumstat(output) {
	return output.split("\0").flatMap((entry) => {
		const firstTab = entry.indexOf("\t");
		const secondTab = entry.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) return [];
		const path = entry.slice(secondTab + 1);
		if (!path) return [];
		const added = Number(entry.slice(0, firstTab));
		const removed = Number(entry.slice(firstTab + 1, secondTab));
		return [{ path, added: Number.isSafeInteger(added) && added >= 0 ? added : 0, removed: Number.isSafeInteger(removed) && removed >= 0 ? removed : 0 }];
	});
}

function addChange(changes, change) {
	const prior = changes.get(change.path);
	changes.set(change.path, {
		path: change.path,
		added: (prior?.added ?? 0) + change.added,
		removed: (prior?.removed ?? 0) + change.removed,
	});
}

export class GitChanges {
	constructor(cwd) {
		this.cwd = cwd;
	}

	summary() {
		const results = [
			gitOutput(this.cwd, ["diff", "--cached", "--numstat", "--no-renames", "-z"]),
			gitOutput(this.cwd, ["diff", "--numstat", "--no-renames", "-z"]),
			gitOutput(this.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
		];
		if (results.some((result) => result.unavailable)) {
			return { unavailable: true, total: 0, added: 0, removed: 0, details: [] };
		}
		const changes = new Map();
		for (const result of results.slice(0, 2)) {
			for (const change of parseNumstat(result.output)) addChange(changes, change);
		}
		for (const path of results[2].output.split("\0")) {
			if (!path || changes.has(path)) continue;
			changes.set(path, { path, added: 0, removed: 0 });
		}
		const entries = [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
		return {
			total: entries.length,
			added: entries.reduce((total, entry) => total + entry.added, 0),
			removed: entries.reduce((total, entry) => total + entry.removed, 0),
			details: entries.map((entry) => `${entry.path} +${entry.added} -${entry.removed}`),
		};
	}

	detail(path) {
		const results = [
			gitOutput(this.cwd, ["diff", "--cached", "--no-ext-diff", "--", path]),
			gitOutput(this.cwd, ["diff", "--no-ext-diff", "--", path]),
			gitOutput(this.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
		];
		if (results.some((result) => result.unavailable)) return "Git changes unavailable.";
		const diff = results.slice(0, 2).map((result) => result.output).filter(Boolean).join("\n");
		if (diff) return diff;
		return results[2].output.split("\0").includes(path) ? `Untracked file: ${path}` : undefined;
	}
}
