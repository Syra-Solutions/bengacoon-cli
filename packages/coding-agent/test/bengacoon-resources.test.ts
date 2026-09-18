import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "bengacoon-resources-"));
	tempDirs.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("built-in Bengacoon resources", () => {
	it("loads workflow extensions, skills, and prompts without user settings", async () => {
		const cwd = await tempDir();
		const agentDir = await tempDir();
		const services = await createAgentSessionServices({ cwd, agentDir });
		const extensions = services.resourceLoader.getExtensions();
		expect(extensions.errors).toEqual([]);
		expect(extensions.extensions.flatMap((extension) => [...extension.commands.keys()])).toEqual(
			expect.arrayContaining(["jobs", "bengacoon-status", "syra-models"]),
		);
		expect(extensions.extensions.flatMap((extension) => [...extension.tools.keys()])).toContain(
			"bengacoon_start_job",
		);
		expect(services.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["change-router", "verified-change", "explore"]),
		);
		expect(services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual(
			expect.arrayContaining(["change", "fix", "specify"]),
		);
	});
});
