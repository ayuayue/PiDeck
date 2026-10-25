import { enumerateWindows, GetSystemMetrics, type WindowInfo } from "./CuaWin32";

/**
 * Analyze the Z-ordered window stack to choose safe click points.
 *
 * Windows are enumerated front-to-back. A window may be partially or fully
 * covered by windows earlier in the array. We compute the visible rectangle
 * of each window and pick a title-bar point that is not occluded.
 */

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const TITLE_BAR_HEIGHT = 30;

export type DisplayInfo = {
	width: number;
	height: number;
};

export type VirtualDisplayInfo = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type ScreenRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type OcclusionInfo = {
	window: WindowInfo;
	visibleRect: { x: number; y: number; width: number; height: number };
	/** Exact visible fragments (before bounding-box merge), for point hit tests. */
	visibleRects: ScreenRect[];
	occludedArea: number;
	titleBarPoint?: { x: number; y: number };
};

export function getPrimaryDisplay(): DisplayInfo {
	return {
		width: GetSystemMetrics(SM_CXSCREEN),
		height: GetSystemMetrics(SM_CYSCREEN),
	};
}

/**
 * Full virtual desktop bounds (all monitors). Input injection MUST normalize
 * against this rect, not the primary display: MOUSEEVENTF_VIRTUALDESK maps
 * 0..65535 across the entire virtual desktop, whose origin can be negative on
 * multi-monitor layouts. Using primary-only metrics there sends the cursor to
 * the wrong screen (or clamps it to (0,0)).
 */
export function getVirtualDisplay(): VirtualDisplayInfo {
	return {
		x: GetSystemMetrics(SM_XVIRTUALSCREEN),
		y: GetSystemMetrics(SM_YVIRTUALSCREEN),
		width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
		height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
	};
}

/**
 * Compute the intersection of two rectangles.
 */
function intersectRects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
	const x1 = Math.max(a.x, b.x);
	const y1 = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.width, b.x + b.width);
	const y2 = Math.min(a.y + a.height, b.y + b.height);
	const width = x2 - x1;
	const height = y2 - y1;
	if (width <= 0 || height <= 0) return null;
	return { x: x1, y: y1, width, height };
}

function rectArea(r: { x: number; y: number; width: number; height: number }): number {
	return r.width * r.height;
}

/**
 * Subtract rectangle `b` from `a`, returning the remaining pieces.
 * Used to accumulate visible area after each occluder.
 */
function subtractRect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number }[] {
	const inter = intersectRects(a, b);
	if (!inter) return [a];

	const pieces: { x: number; y: number; width: number; height: number }[] = [];

	// Top strip
	if (inter.y > a.y) {
		pieces.push({ x: a.x, y: a.y, width: a.width, height: inter.y - a.y });
	}
	// Bottom strip
	if (inter.y + inter.height < a.y + a.height) {
		pieces.push({
			x: a.x,
			y: inter.y + inter.height,
			width: a.width,
			height: a.y + a.height - (inter.y + inter.height),
		});
	}
	// Left strip
	if (inter.x > a.x) {
		pieces.push({ x: a.x, y: inter.y, width: inter.x - a.x, height: inter.height });
	}
	// Right strip
	if (inter.x + inter.width < a.x + a.width) {
		pieces.push({
			x: inter.x + inter.width,
			y: inter.y,
			width: a.x + a.width - (inter.x + inter.width),
			height: inter.height,
		});
	}

	return pieces;
}

/**
 * Enumerate windows and compute occlusion info.
 */
export function analyzeWindows(options: { includeInvisible?: boolean } = {}): OcclusionInfo[] {
	const includeInvisible = options.includeInvisible ?? false;
	const windows = enumerateWindows(includeInvisible);
	const display = getVirtualDisplay();
	const screenRect: ScreenRect = { x: display.x, y: display.y, width: display.width, height: display.height };

	const result: OcclusionInfo[] = [];
	const occluders: ScreenRect[] = [];

	for (const w of windows) {
		// Invisible windows occupy no pixels: not occluders, nothing visible.
		if (!w.isVisible) {
			result.push({ window: w, visibleRect: { x: 0, y: 0, width: 0, height: 0 }, visibleRects: [], occludedArea: rectArea(w.rect) });
			continue;
		}

		// Clip to virtual desktop bounds.
		const clipped = intersectRects(w.rect, screenRect);
		if (!clipped) {
			result.push({ window: w, visibleRect: { x: 0, y: 0, width: 0, height: 0 }, visibleRects: [], occludedArea: rectArea(w.rect) });
			continue;
		}

		let visiblePieces = [clipped];
		for (const occ of occluders) {
			const next: typeof visiblePieces = [];
			for (const piece of visiblePieces) {
				next.push(...subtractRect(piece, occ));
			}
			visiblePieces = next;
			if (visiblePieces.length === 0) break;
		}

		const visibleArea = visiblePieces.reduce((sum, p) => sum + rectArea(p), 0);
		const clippedArea = rectArea(clipped);
		const occludedArea = clippedArea - visibleArea;

		// Choose the best title-bar point inside the visible pieces.
		const titleBarY = w.rect.y + Math.min(TITLE_BAR_HEIGHT, Math.floor(w.rect.height / 4));
		const titleBarX = w.rect.x + Math.floor(w.rect.width / 2);
		let titleBarPoint: { x: number; y: number } | undefined;
		if (titleBarY < clipped.y + clipped.height) {
			for (const piece of visiblePieces) {
				if (titleBarX >= piece.x && titleBarX < piece.x + piece.width && titleBarY >= piece.y && titleBarY < piece.y + piece.height) {
					titleBarPoint = { x: titleBarX, y: titleBarY };
					break;
				}
			}
		}

		// If center title-bar is occluded, try a few fallback x offsets.
		if (!titleBarPoint) {
			const offsets = [0.25, 0.75, 0.1, 0.9];
			for (const offset of offsets) {
				const fx = w.rect.x + Math.floor(w.rect.width * offset);
				for (const piece of visiblePieces) {
					if (fx >= piece.x && fx < piece.x + piece.width && titleBarY >= piece.y && titleBarY < piece.y + piece.height) {
						titleBarPoint = { x: fx, y: titleBarY };
						break;
					}
				}
				if (titleBarPoint) break;
			}
		}

		// Merge visible pieces into a single bounding visible rect for diagnostics.
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of visiblePieces) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x + p.width);
			maxY = Math.max(maxY, p.y + p.height);
		}
		const visibleRect = visiblePieces.length > 0 ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : { x: 0, y: 0, width: 0, height: 0 };

		result.push({ window: w, visibleRect, visibleRects: visiblePieces, occludedArea, titleBarPoint });

		// Add this window's rectangle as an occluder for subsequent (behind) windows.
		occluders.push(clipped);
	}

	return result;
}

/**
 * Find a window whose title contains the given substring (case-insensitive).
 */
export function findWindowByTitle(titleSubstring: string): OcclusionInfo | undefined {
	const analyzed = analyzeWindows({ includeInvisible: true });
	const needle = titleSubstring.toLowerCase();
	// Prefer visible matches; fall back to hidden windows (activatable via restore).
	return analyzed.find((info) => info.window.isVisible && info.window.title.toLowerCase().includes(needle)) ?? analyzed.find((info) => info.window.title.toLowerCase().includes(needle));
}

/**
 * Find the foreground window info.
 */
export function getForegroundWindowInfo(): OcclusionInfo | undefined {
	const analyzed = analyzeWindows();
	return analyzed.find((info) => info.window.isForeground);
}
