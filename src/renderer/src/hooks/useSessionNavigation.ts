import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { sessionRecordsAtom } from "../atoms";
import { pruneSessionHistory, visitSession, type SessionNavigationHistory } from "../utils/sessionNavigationHistory";

export function useSessionNavigation(currentSessionId: string | undefined, select: (id: string) => void) {
	const records = useAtomValue(sessionRecordsAtom);
	const [history, setHistory] = useState<SessionNavigationHistory>({ entries: [], index: -1 });
	const pendingRef = useRef<string | null>(null);
	useEffect(() => {
		const navigatingTo = pendingRef.current;
		if (navigatingTo && navigatingTo !== currentSessionId && records[navigatingTo]) return;
		pendingRef.current = null;
		setHistory((previous) => {
			const next = pruneSessionHistory(previous, (id) => Boolean(records[id]));
			if (!currentSessionId || !records[currentSessionId]) return next;
			return visitSession(next, currentSessionId);
		});
	}, [currentSessionId, records]);
	const move = (offset: number) => {
		if (pendingRef.current) return;
		const index = history.index + offset;
		const id = history.entries[index];
		if (!id || !records[id]) return;
		pendingRef.current = id;
		setHistory({ ...history, index });
		select(id);
	};
	return { canBack: history.index > 0, canForward: history.index + 1 < history.entries.length, back: () => move(-1), forward: () => move(1) };
}
