import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultResourceLoaderOptions } from "./resource-loader.ts";

type ResourceLoaderDefaults = Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;

function findBengacoonResourceRoot(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(moduleDir, "bengacoon-resources"),
		join(moduleDir, "..", "bengacoon-resources"),
		join(moduleDir, "..", "..", "bengacoon-resources"),
		resolve(moduleDir, "..", "..", "..", "bengacoon"),
	];
	const root = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
	if (!root) {
		throw new Error("Built-in Bengacoon resources are missing from this installation.");
	}
	return root;
}

export function withBengacoonResources(options: ResourceLoaderDefaults = {}): ResourceLoaderDefaults {
	const root = findBengacoonResourceRoot();
	return {
		...options,
		additionalExtensionPaths: options.noExtensions
			? options.additionalExtensionPaths
			: [
					join(root, "extensions", "bengacoon.ts"),
					join(root, "extensions", "orchestrator.ts"),
					...(options.additionalExtensionPaths ?? []),
				],
		additionalSkillPaths: options.noSkills
			? options.additionalSkillPaths
			: [join(root, "skills"), ...(options.additionalSkillPaths ?? [])],
		additionalPromptTemplatePaths: options.noPromptTemplates
			? options.additionalPromptTemplatePaths
			: [join(root, "prompts"), ...(options.additionalPromptTemplatePaths ?? [])],
	};
}
