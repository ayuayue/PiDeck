export type FloatingMenuAnchor = {
	left: number;
	top: number;
	bottom: number;
};

export type FloatingMenuViewport = {
	width: number;
	height: number;
};

export type FloatingMenuPlacement = {
	left: number;
	top: number | "auto";
	bottom: number | "auto";
	width: number;
	maxHeight: number;
};

export type FloatingMenuOptions = {
	preferredWidth: number;
	maxHeight: number;
	margin?: number;
	gap?: number;
	minBelowHeight?: number;
};

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 4;
const DEFAULT_MIN_BELOW_HEIGHT = 160;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(value, maximum));
}

/**
 * Portal menus must be positioned against the renderer viewport, not their
 * drawer ancestor. This keeps a long branch name menu on-screen when its
 * trigger sits near the right or bottom edge of the window.
 */
export function getViewportBoundMenuPlacement(anchor: FloatingMenuAnchor, viewport: FloatingMenuViewport, options: FloatingMenuOptions): FloatingMenuPlacement {
	const requestedMargin = options.margin ?? DEFAULT_MARGIN;
	const horizontalMargin = Math.min(requestedMargin, viewport.width / 2);
	const verticalMargin = Math.min(requestedMargin, viewport.height / 2);
	const gap = options.gap ?? DEFAULT_GAP;
	const availableWidth = Math.max(0, viewport.width - horizontalMargin * 2);
	const width = Math.min(options.preferredWidth, availableWidth);
	const left = clamp(anchor.left, horizontalMargin, Math.max(horizontalMargin, viewport.width - horizontalMargin - width));

	const belowTop = anchor.bottom + gap;
	const availableBelow = Math.max(0, viewport.height - verticalMargin - belowTop);
	const availableAbove = Math.max(0, anchor.top - verticalMargin - gap);
	const minBelowHeight = Math.min(options.maxHeight, options.minBelowHeight ?? DEFAULT_MIN_BELOW_HEIGHT);
	const opensUpward = availableBelow < minBelowHeight && availableAbove > availableBelow;

	if (opensUpward) {
		return {
			left,
			top: "auto",
			bottom: viewport.height - anchor.top + gap,
			width,
			maxHeight: Math.min(options.maxHeight, availableAbove),
		};
	}

	return {
		left,
		top: belowTop,
		bottom: "auto",
		width,
		maxHeight: Math.min(options.maxHeight, availableBelow),
	};
}
