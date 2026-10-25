export const WEB_MOBILE_MAX_WIDTH = 760;

export function isMobileViewport(width: number): boolean {
	return width <= WEB_MOBILE_MAX_WIDTH;
}

export function readViewportWidth(): number {
	return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
}
