export type SessionNavigationHistory = { entries: string[]; index: number };

export function visitSession(history: SessionNavigationHistory, sessionId: string): SessionNavigationHistory {
	if (history.entries[history.index] === sessionId) return history;
	const entries = [...history.entries.slice(0, history.index + 1), sessionId];
	return { entries, index: entries.length - 1 };
}

export function pruneSessionHistory(history: SessionNavigationHistory, exists: (id: string) => boolean): SessionNavigationHistory {
	const entries = history.entries.filter(exists);
	if (entries.length === history.entries.length) return history;
	const preceding = history.entries.slice(0, history.index + 1).filter(exists).length;
	return { entries, index: Math.max(-1, preceding - 1) };
}
