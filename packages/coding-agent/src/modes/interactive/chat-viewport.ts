import { type Component, HStack, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";

export const SIDEBAR_BREAKPOINT = 120;
export const SIDEBAR_WIDTH = 36;

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly sidebar?: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	const chat = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	const root = options.sidebar
		? new HStack([
				{ component: chat, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{
					component: options.sidebar,
					basis: SIDEBAR_WIDTH,
					grow: 0,
					shrink: 0,
					minSize: SIDEBAR_WIDTH,
					maxSize: SIDEBAR_WIDTH,
					visible: ({ width }) => width >= SIDEBAR_BREAKPOINT,
				},
			])
		: chat;
	return { transcript, root };
}
