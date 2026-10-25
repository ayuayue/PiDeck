import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface UseAutoScrollOptions {
	/** Changing this key triggers a full reset: re‑enable autoScroll and scroll to bottom. */
	key?: string;
	/** Changing this key rebuilds the ResizeObserver (e.g., agent status transitions). */
	statusKey?: string;
}

export interface UseAutoScrollReturn {
	autoScroll: boolean;
	autoScrollRef: React.MutableRefObject<boolean>;
	programmaticScrollRef: React.MutableRefObject<boolean>;
	showScrollToBottom: boolean;
	scrollToBottom: () => void;
	setAutoScroll: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Manages auto‑scroll behaviour for a message timeline container.
 *
 * - Tracks whether the user has scrolled away from the bottom.
 * - Uses ResizeObserver to auto‑scroll while new content arrives.
 * - Distinguishes programmatic scrolls from user scrolls to avoid races.
 * - Resets when `options.key` changes (agent / session switch).
 */
export function useAutoScroll(timelineRef: RefObject<HTMLElement | null>, options?: UseAutoScrollOptions): UseAutoScrollReturn {
	const [autoScroll, setAutoScroll] = useState(true);
	/** ref mirror of autoScroll so ResizeObserver callbacks always read the latest value */
	const autoScrollRef = useRef(true);
	autoScrollRef.current = autoScroll;

	/**
	 * Marks the next "scroll" DOM event as programmatic — prevents it from
	 * disabling autoScroll when we intentionally scroll to the bottom.
	 */
	const programmaticScrollRef = useRef(false);

	/** Whether to show a "scroll to bottom" floating button */
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);

	const key = options?.key;
	const statusKey = options?.statusKey;

	// -- scrollToBottom ---------------------------------------------------

	const scrollToBottom = useCallback(() => {
		const timeline = timelineRef.current;
		if (!timeline) return;
		programmaticScrollRef.current = true;
		timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
		setAutoScroll(true);
		autoScrollRef.current = true;
		setShowScrollToBottom(false);
	}, [timelineRef]);

	// -- reset on key change (agent / session switch) --------------------

	useEffect(() => {
		setAutoScroll(true);
		autoScrollRef.current = true;
		setShowScrollToBottom(false);
		const frame = requestAnimationFrame(() => {
			const timeline = timelineRef.current;
			if (timeline) {
				programmaticScrollRef.current = true;
				timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [key, timelineRef]);

	// -- scroll event listener (user vs. programmatic) -------------------

	useEffect(() => {
		const timeline = timelineRef.current;
		if (!timeline) return;

		const handleScroll = () => {
			const { scrollTop, scrollHeight, clientHeight } = timeline;
			const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

			// programmatic scrolls (ResizeObserver / scrollToBottom etc.) may
			// only *enable* autoScroll — never disable it — to avoid a race
			// where scrollHeight changes between the scrollTo call and the
			// next scroll event, making it look like the user scrolled away.
			if (programmaticScrollRef.current) {
				programmaticScrollRef.current = false;
				if (isAtBottom) {
					setAutoScroll(true);
					autoScrollRef.current = true;
					setShowScrollToBottom(false);
				}
				// not at bottom → do nothing; let the next real event decide
				return;
			}

			if (isAtBottom) {
				setAutoScroll(true);
				autoScrollRef.current = true;
				setShowScrollToBottom(false);
			} else {
				setAutoScroll(false);
				// sync ref immediately so the ResizeObserver callback (which runs
				// before React re-render) reads the latest value.
				autoScrollRef.current = false;
				setShowScrollToBottom(true);
			}
		};

		// initial check
		handleScroll();

		timeline.addEventListener("scroll", handleScroll);
		return () => timeline.removeEventListener("scroll", handleScroll);
	}, [key, timelineRef]);

	// -- ResizeObserver auto‑scroll --------------------------------------

	useEffect(() => {
		const timeline = timelineRef.current;
		if (!timeline) return;
		const messageList = timeline.querySelector(".message-list");
		if (!messageList) return;

		const scrollIfNeeded = () => {
			if (!autoScrollRef.current) return;
			programmaticScrollRef.current = true;
			timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
		};

		// fire once when the observer is (re)built — catches the
		// autoScroll false → true transition where the list height hasn't changed.
		scrollIfNeeded();

		const resizeObserver = new ResizeObserver(scrollIfNeeded);
		resizeObserver.observe(messageList);

		return () => resizeObserver.disconnect();
	}, [key, autoScroll, statusKey, timelineRef]);

	return {
		autoScroll,
		autoScrollRef,
		programmaticScrollRef,
		showScrollToBottom,
		scrollToBottom,
		setAutoScroll,
	};
}
