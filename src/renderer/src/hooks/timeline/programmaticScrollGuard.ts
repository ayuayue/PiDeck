/**
 * Programmatic timeline scroll suppression.
 *
 * A deadline is the source of truth for timed suppression. Keeping a separate
 * boolean lets the flag remain latched after the deadline and permanently
 * swallow later reader input. Generation tokens also keep an older rAF cleanup
 * from clearing a newer suppression window.
 */
export type ProgrammaticScrollGuard = {
	generation: number;
	suppressUntil: number;
};

export function createProgrammaticScrollGuard(): ProgrammaticScrollGuard {
	return { generation: 0, suppressUntil: 0 };
}

/** Begin suppression and return the generation owned by a next-frame cleanup. */
export function beginProgrammaticScroll(state: ProgrammaticScrollGuard, now: number, durationMs: number): number {
	state.generation += 1;
	if (durationMs > 0) {
		const requestedUntil = now + durationMs;
		// A newer timed window replaces a pending one-frame marker, but must not
		// shorten another timed guard that is still protecting layout scrolls.
		state.suppressUntil = state.suppressUntil === Number.POSITIVE_INFINITY ? requestedUntil : Math.max(state.suppressUntil, requestedUntil);
	} else if (state.suppressUntil <= now) {
		// An active timed window already covers this frame. Leaving its finite
		// deadline intact prevents this frame's rAF cleanup from ending it early.
		state.suppressUntil = Number.POSITIVE_INFINITY;
	}
	return state.generation;
}

/** Release a one-frame suppression only when no newer scroll has replaced it. */
export function finishProgrammaticScrollFrame(state: ProgrammaticScrollGuard, generation: number): void {
	if (state.generation === generation && state.suppressUntil === Number.POSITIVE_INFINITY) {
		state.suppressUntil = 0;
	}
}

export function clearProgrammaticScroll(state: ProgrammaticScrollGuard): void {
	state.generation += 1;
	state.suppressUntil = 0;
}

export function isProgrammaticScrollActive(state: ProgrammaticScrollGuard, now: number): boolean {
	return now < state.suppressUntil;
}
