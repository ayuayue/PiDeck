import { useCallback, useRef, useState } from "react";
import { INITIAL_HEADER_AUTO_HIDE_STATE, stepHeaderAutoHide, type HeaderAutoHideState } from "./headerAutoHide";
import { readViewportWidth } from "./webViewport";

export function useWebHeaderAutoHide(isForceVisible: () => boolean) {
	const [hidden, setHidden] = useState(false);
	const stateRef = useRef<HeaderAutoHideState>(INITIAL_HEADER_AUTO_HIDE_STATE);

	const reveal = useCallback(() => {
		stateRef.current = INITIAL_HEADER_AUTO_HIDE_STATE;
		setHidden(false);
	}, []);

	const reportScroll = useCallback(
		(scrollTop: number, delta: number) => {
			const next = stepHeaderAutoHide(stateRef.current, { scrollTop, delta, viewportWidth: readViewportWidth(), forceVisible: isForceVisible() });
			if (next.hidden === stateRef.current.hidden) {
				stateRef.current = next;
				return;
			}
			stateRef.current = next;
			setHidden(next.hidden);
		},
		[isForceVisible],
	);

	return { hidden, reportScroll, reveal };
}
