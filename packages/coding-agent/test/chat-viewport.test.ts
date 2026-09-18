import { type Component, Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";

function widthProbe(label: string): Component {
	return {
		render: (width) => [`${label}${width}`],
		invalidate() {},
	};
}

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("reserves a 36-column sidebar at 120 columns and restores chat width below it", () => {
		const viewport = createChatViewport({
			document: widthProbe("chat:"),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			sidebar: widthProbe("sidebar:"),
		});

		const wide = viewport.root.render(120)[0] ?? "";
		const narrow = viewport.root.render(119)[0] ?? "";
		const plainWide = stripTerminalSequences(wide);
		const plainNarrow = stripTerminalSequences(narrow);

		expect(plainWide.startsWith("chat:84")).toBe(true);
		expect(plainWide.indexOf("sidebar:36")).toBe(84);
		expect(visibleWidth(wide)).toBe(120);
		expect(plainNarrow.trimEnd()).toBe("chat:119");
	});
});
