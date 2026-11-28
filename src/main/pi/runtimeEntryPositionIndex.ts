type EntryWithMeta = { meta?: Record<string, unknown> | null };

type EntryPositionCache = {
	positions: Map<string, number>;
	indexedLength: number;
};

const cache = new WeakMap<ReadonlyArray<EntryWithMeta>, EntryPositionCache>();

/** Build once, index appended messages incrementally, and rebuild after the array shrinks. */
export function runtimeEntryPositions(list: ReadonlyArray<EntryWithMeta>): Map<string, number> {
	let state = cache.get(list);
	if (!state || state.indexedLength > list.length) {
		state = { positions: new Map(), indexedLength: 0 };
		cache.set(list, state);
	}
	for (let index = state.indexedLength; index < list.length; index += 1) {
		const entryId = list[index]?.meta?.entryId;
		if (typeof entryId === "string" && entryId && !state.positions.has(entryId)) state.positions.set(entryId, index);
	}
	state.indexedLength = list.length;
	return state.positions;
}
