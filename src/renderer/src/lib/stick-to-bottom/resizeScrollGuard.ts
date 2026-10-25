/**
 * Resize-induced scroll events must not be treated as reader scroll intent.
 *
 * A generation token is required instead of comparing the pixel difference:
 * streaming rows commonly grow by the same line height in consecutive frames.
 * An older cleanup must never clear the guard installed by a newer resize.
 */
export type ResizeScrollGuardState = {
	resizeDifference: number;
	resizeGeneration: number;
};

/** Mark the latest layout resize and return its unique cleanup token. */
export function markResizeScrollGuard(state: ResizeScrollGuardState, difference: number): number {
	state.resizeDifference = difference;
	state.resizeGeneration += 1;
	return state.resizeGeneration;
}

/** Clear only the guard that is still the latest observed resize. */
export function clearResizeScrollGuard(state: ResizeScrollGuardState, generation: number): void {
	if (state.resizeGeneration === generation) {
		state.resizeDifference = 0;
	}
}
