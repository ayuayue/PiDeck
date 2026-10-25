import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

export const SESSION_LAYOUT_DEFAULTS = {
	headerHeight: 78,
	composerMinHeight: 175,
	composerMinTimelineHeight: 160,
	composerFloor: 180,
	terminalMinHeight: 120,
	terminalCollapsedHeight: 34,
	queuedRowHeight: 34,
	queuedChrome: 38,
	composerGap: 28,
} as const;

export type SessionLayoutInput = {
	chatPaneHeight: number;
	headerHeight: number;
	composerChromeHeight: number;
	terminalRequestedHeight: number;
	terminalOpen: boolean;
	terminalClosing: boolean;
	terminalCollapsed: boolean;
	queuedPromptCount: number;
	queuedPromptVisible?: number;
};

export function calculateSessionLayout(input: SessionLayoutInput) {
	const settings = SESSION_LAYOUT_DEFAULTS;
	const queuedBudget = input.queuedPromptCount > 0 ? settings.queuedChrome + Math.min(input.queuedPromptCount, input.queuedPromptVisible ?? 3) * settings.queuedRowHeight : 0;
	const requestedTerminalHeight = !input.terminalOpen || input.terminalClosing ? 0 : input.terminalCollapsed ? settings.terminalCollapsedHeight : input.terminalRequestedHeight;
	const availableTerminalHeight = Math.max(0, input.chatPaneHeight - input.headerHeight - settings.composerMinTimelineHeight - settings.composerMinHeight - settings.composerGap - queuedBudget);
	const terminalRowHeight = input.terminalCollapsed ? requestedTerminalHeight : Math.min(requestedTerminalHeight, availableTerminalHeight);
	const maxComposerHeight = Math.max(settings.composerFloor, input.chatPaneHeight - input.headerHeight - settings.composerMinTimelineHeight - terminalRowHeight - input.composerChromeHeight);
	return { queuedBudget, terminalRowHeight, maxComposerHeight, availableTerminalHeight };
}

export function useSessionLayout(options: Omit<SessionLayoutInput, "chatPaneHeight" | "headerHeight" | "composerChromeHeight">) {
	const chatPaneRef = useRef<HTMLElement | null>(null);
	const headerRef = useRef<HTMLDivElement | null>(null);
	const composerRef = useRef<HTMLElement | null>(null);
	const composerBoxRef = useRef<HTMLElement | null>(null);
	const [measurements, setMeasurements] = useState<{
		chatPaneHeight: number;
		headerHeight: number;
		composerChromeHeight: number;
	}>({
		chatPaneHeight: typeof window === "undefined" ? 0 : window.innerHeight,
		headerHeight: SESSION_LAYOUT_DEFAULTS.headerHeight,
		composerChromeHeight: 0,
	});

	const measure = useCallback(() => {
		const chatPaneHeight = chatPaneRef.current?.clientHeight ?? window.innerHeight;
		const headerHeight = headerRef.current?.offsetHeight ?? SESSION_LAYOUT_DEFAULTS.headerHeight;
		const composerHeight = composerRef.current?.offsetHeight ?? 0;
		const composerBoxHeight = composerBoxRef.current?.offsetHeight ?? 0;
		const composerChromeHeight = Math.max(0, composerHeight - composerBoxHeight);
		setMeasurements((current) => (current.chatPaneHeight === chatPaneHeight && current.headerHeight === headerHeight && current.composerChromeHeight === composerChromeHeight ? current : { chatPaneHeight, headerHeight, composerChromeHeight }));
	}, []);

	useEffect(() => {
		let frame = 0;
		const scheduleMeasure = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};
		const observer = new ResizeObserver(scheduleMeasure);
		for (const element of [chatPaneRef.current, headerRef.current, composerRef.current, composerBoxRef.current]) {
			if (element) observer.observe(element);
		}
		window.addEventListener("resize", scheduleMeasure);
		scheduleMeasure();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", scheduleMeasure);
		};
	}, [measure]);

	const layout = useMemo(() => calculateSessionLayout({ ...options, ...measurements }), [options, measurements]);
	const clampComposerHeight = useCallback((height: number) => Math.min(layout.maxComposerHeight, Math.max(SESSION_LAYOUT_DEFAULTS.composerMinHeight, height)), [layout.maxComposerHeight]);
	const clampTerminalHeight = useCallback((height: number) => Math.min(layout.availableTerminalHeight, Math.max(SESSION_LAYOUT_DEFAULTS.terminalMinHeight, height)), [layout.availableTerminalHeight]);

	return {
		chatPaneRef,
		headerRef,
		composerRef,
		composerBoxRef,
		measure,
		...layout,
		clampComposerHeight,
		clampTerminalHeight,
	} satisfies {
		chatPaneRef: RefObject<HTMLElement | null>;
		headerRef: RefObject<HTMLDivElement | null>;
		composerRef: RefObject<HTMLElement | null>;
		composerBoxRef: RefObject<HTMLElement | null>;
		measure: () => void;
		queuedBudget: number;
		terminalRowHeight: number;
		maxComposerHeight: number;
		availableTerminalHeight: number;
		clampComposerHeight: (height: number) => number;
		clampTerminalHeight: (height: number) => number;
	};
}
