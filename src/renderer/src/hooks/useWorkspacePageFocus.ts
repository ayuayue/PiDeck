import { useEffect, useRef } from "react";

/** Move keyboard focus into a workspace page when its tab becomes active. */
export function useWorkspacePageFocus(active: boolean) {
	const pageRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const page = pageRef.current;
		if (active && page && !page.contains(document.activeElement)) page.focus();
	}, [active]);
	return pageRef;
}
