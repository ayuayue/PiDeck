/** Pixels per second for one-pass sidebar title scrolling. */
export const TITLE_SCROLL_PIXELS_PER_SECOND = 30;

/** Convert measured overflow distance to an uncapped constant-speed duration. */
export function titleScrollDurationMs(distancePx: number): number {
	return (distancePx / TITLE_SCROLL_PIXELS_PER_SECOND) * 1000;
}
