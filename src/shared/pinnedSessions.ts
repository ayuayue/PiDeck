/**
 * Normalize persisted pinned SessionRecord ids at the settings boundary.
 * Invalid and duplicate entries are ignored so a damaged settings file cannot
 * break Sidebar rendering or produce unbounded duplicate state.
 */
export function normalizePinnedSessionIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const ids = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string") continue;
		const id = candidate.trim();
		if (id) ids.add(id);
	}
	return [...ids];
}
