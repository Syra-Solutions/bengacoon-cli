import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { CacheWarmPlan } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function streamingResponse(model: string): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_test", model, usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("Anthropic cache warming", () => {
	it("replays the final payload as a non-streaming zero-token request", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const requests: Array<Record<string, unknown>> = [];
		const warmResponse = {
			model: model.id,
			content: [],
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 10,
				cache_creation_input_tokens: 0,
			},
		} as unknown as BetaMessage;
		const client = {
			beta: {
				messages: {
					create: (params: Record<string, unknown>) => {
						requests.push(structuredClone(params));
						return params.stream
							? { asResponse: async () => streamingResponse(model.id) }
							: Promise.resolve(warmResponse);
					},
				},
			},
		} as unknown as Anthropic;
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		let plan: CacheWarmPlan | undefined;

		await streamAnthropic(model, context, {
			client,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), metadata: { user_id: "test" } }),
			onCacheWarmPlan: (value) => {
				plan = value;
			},
		}).result();
		expect(plan).toBeDefined();
		const result = await plan!.warm(new AbortController().signal);

		expect(requests[1]).toEqual({ ...requests[0], stream: false, max_tokens: 0 });
		expect(result.usage).toMatchObject({ cacheRead: 10, cacheWrite: 0, output: 0 });
	});
});
