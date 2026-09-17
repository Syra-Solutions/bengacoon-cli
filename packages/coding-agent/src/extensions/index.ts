import type { InlineExtension } from "../core/extensions/types.ts";
import cacheWarmingExtension from "./cache-warming.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "cache-warming", factory: cacheWarmingExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
