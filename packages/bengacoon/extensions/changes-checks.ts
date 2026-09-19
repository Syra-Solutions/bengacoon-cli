import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitChanges } from "./changes.ts";

const repository = mkdtempSync(join(tmpdir(), "bengacoon-changes-"));
try {
	execFileSync("git", ["init", "--quiet"], { cwd: repository });
	execFileSync("git", ["config", "user.email", "checks@example.com"], { cwd: repository });
	execFileSync("git", ["config", "user.name", "Checks"], { cwd: repository });
	writeFileSync(join(repository, "tracked.txt"), "alpha\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
	execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repository });
	writeFileSync(join(repository, "tracked.txt"), "alpha\nbeta\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
	writeFileSync(join(repository, "tracked.txt"), "alpha\nbeta\ngamma\n");
	writeFileSync(join(repository, "untracked.txt"), "new\nline\n");

	const gitChanges = new GitChanges(repository);
	assert.deepEqual(gitChanges.summary(), {
		total: 2,
		added: 2,
		removed: 0,
		details: ["tracked.txt +2 -0", "untracked.txt +0 -0"],
	});

	execFileSync("git", ["add", "."], { cwd: repository });
	execFileSync("git", ["commit", "--quiet", "-m", "clean"], { cwd: repository });
	assert.deepEqual(gitChanges.summary(), { total: 0, added: 0, removed: 0, details: [] });
} finally {
	rmSync(repository, { recursive: true, force: true });
}

const unbornRepository = mkdtempSync(join(tmpdir(), "bengacoon-unborn-changes-"));
const outsideFile = `${unbornRepository}-outside.txt`;
try {
	execFileSync("git", ["init", "--quiet"], { cwd: unbornRepository });
	writeFileSync(join(unbornRepository, "staged.txt"), "staged\n");
	execFileSync("git", ["add", "staged.txt"], { cwd: unbornRepository });
	writeFileSync(join(unbornRepository, "untracked.txt"), "untracked\n");
	writeFileSync(outsideFile, "outside secret\n");
	symlinkSync(outsideFile, join(unbornRepository, "outside-link"));

	const unbornChanges = new GitChanges(unbornRepository);
	assert.deepEqual(unbornChanges.summary(), {
		total: 3,
		added: 1,
		removed: 0,
		details: ["outside-link +0 -0", "staged.txt +1 -0", "untracked.txt +0 -0"],
	});
	assert.equal(unbornChanges.detail("outside-link"), "Untracked file: outside-link");
} finally {
	rmSync(unbornRepository, { recursive: true, force: true });
	rmSync(outsideFile, { force: true });
}

const nonRepository = mkdtempSync(join(tmpdir(), "bengacoon-non-repository-"));
try {
	assert.deepEqual(new GitChanges(nonRepository).summary(), {
		unavailable: true,
		total: 0,
		added: 0,
		removed: 0,
		details: [],
	});
} finally {
	rmSync(nonRepository, { recursive: true, force: true });
}

console.log("Git changes checks passed");
