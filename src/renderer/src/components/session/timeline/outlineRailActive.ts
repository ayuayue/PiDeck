/**
 * Pure selection rules for the session outline rail.
 *
 * Positions are measured in timeline content coordinates, so scroll handling can
 * locate the active checkpoint without reading message DOM geometry every frame.
 */
export type OutlineItemWithId = {
	id: string;
};

export type OutlineItemPosition = {
	id: string;
	top: number;
};

export type OutlineItemIndex = ReadonlyMap<string, number>;
export type OutlineRailItem = OutlineItemWithId & {
	role: string;
	title: string;
	time: string;
};

export function areOutlineRailItemsEqual(previous: readonly OutlineRailItem[], next: readonly OutlineRailItem[]): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) {
		const left = previous[index]!;
		const right = next[index]!;
		if (left.id !== right.id || left.role !== right.role || left.title !== right.title || left.time !== right.time) return false;
	}
	return true;
}

export function createOutlineItemIndex<T extends OutlineItemWithId>(items: readonly T[]): OutlineItemIndex {
	const indexById = new Map<string, number>();
	for (let index = 0; index < items.length; index += 1) {
		indexById.set(items[index]!.id, index);
	}
	return indexById;
}

/**
 * Returns the last checkpoint at or above the viewport anchor. Positions must
 * be finite and sorted from top to bottom, which makes the scroll hot path a
 * binary search instead of a full message-DOM scan.
 */
export function resolveActiveOutlineItemId(positions: readonly OutlineItemPosition[], anchorOffset: number): string | undefined {
	let low = 0;
	let high = positions.length - 1;
	let activeIndex = -1;

	while (low <= high) {
		const middle = (low + high) >>> 1;
		const position = positions[middle]!;
		if (position.top <= anchorOffset) {
			activeIndex = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return activeIndex >= 0 ? positions[activeIndex]!.id : positions[0]?.id;
}

/**
 * A long history may be sampled to fit the available rail height. Keep the
 * current location visible by highlighting the closest rendered checkpoint.
 */
export function resolveVisibleRailActiveId<T extends OutlineItemWithId>(activeId: string | undefined, sourceIndexById: OutlineItemIndex, railItems: readonly T[]): string | undefined {
	if (!activeId) return undefined;

	const sourceIndex = sourceIndexById.get(activeId);
	if (sourceIndex === undefined) return undefined;

	let nearestId: string | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const railItem of railItems) {
		const railIndex = sourceIndexById.get(railItem.id);
		if (railIndex === undefined) continue;
		const distance = Math.abs(railIndex - sourceIndex);
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestId = railItem.id;
		}
	}

	return nearestId;
}
