import { screen, type Screen } from "electron";

/**
 * Display enumeration for CUA.
 *
 * CUA has two coordinate spaces that must agree before the model can act on a
 * screenshot:
 * - Electron `screen` API works in DIP (logical) pixels, per monitor.
 * - Input injection (`SendInput` + `GetSystemMetrics`, see CuaWin32) and window
 *   rects work in physical pixels of the whole virtual desktop, whose origin is
 *   negative whenever a monitor sits left of / above the primary one.
 *
 * On a 200% secondary display the same pixel means two different places, so the
 * model needs the physical rect of the display it is looking at: with it,
 * `screenX = rect.x + imageX * rect.width / imageWidth` maps a screenshot pixel
 * to the exact absolute click coordinate (verified live on a 100%+200% setup).
 */
export type CuaScreenRect = { x: number; y: number; width: number; height: number };

export type CuaDisplayInfo = {
	/** Electron display id, accepted by cua_capture as `displayId`. */
	displayId: string;
	label: string;
	isPrimary: boolean;
	scaleFactor: number;
	/** Rect in the absolute click space (physical pixels, may be negative). */
	bounds: CuaScreenRect;
};

/**
 * Minimal shape of Electron's `Display` so the geometry math stays testable
 * without loading Electron's screen module.
 */
export type DisplayLike = {
	id: number | string;
	label?: string;
	bounds: CuaScreenRect;
	scaleFactor: number;
};

/**
 * Convert a DIP rect + scale factor into the physical click space.
 *
 * Edges are scaled then rounded (never the width) so adjacent displays keep
 * tiling the virtual desktop instead of leaving 1px gaps or overlaps.
 */
export function toScreenRect(bounds: CuaScreenRect, scaleFactor: number): CuaScreenRect {
	const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
	const x = Math.round(bounds.x * scale);
	const y = Math.round(bounds.y * scale);
	return {
		x,
		y,
		width: Math.max(1, Math.round((bounds.x + bounds.width) * scale) - x),
		height: Math.max(1, Math.round((bounds.y + bounds.height) * scale) - y),
	};
}

/**
 * Build the model-facing display list. `primaryId` comes from Electron and is
 * compared loosely because display ids are numbers there but strings in MCP.
 */
export function toCuaDisplays(displays: readonly DisplayLike[], primaryId: number | string): CuaDisplayInfo[] {
	return displays.map((display) => ({
		displayId: String(display.id),
		label: display.label ?? "",
		isPrimary: String(display.id) === String(primaryId),
		scaleFactor: display.scaleFactor,
		bounds: toScreenRect(display.bounds, display.scaleFactor),
	}));
}

/**
 * Enumerate every display in absolute click coordinates, primary first.
 *
 * Returns undefined outside the Electron main process (node test runners load
 * the electron package as a binary path), so read-only callers can degrade to
 * "no display list" instead of throwing.
 */
export function tryListCuaDisplays(): CuaDisplayInfo[] | undefined {
	const activeScreen = screen as Screen | undefined;
	if (!activeScreen || typeof activeScreen.getAllDisplays !== "function") return undefined;

	const primary = activeScreen.getPrimaryDisplay();
	const displays = toCuaDisplays(activeScreen.getAllDisplays(), primary.id);
	// 主屏排第一：模型最常先看主屏，稳定顺序也便于测试断言。
	return [...displays.filter((display) => display.isPrimary), ...displays.filter((display) => !display.isPrimary)];
}

export function listCuaDisplays(): CuaDisplayInfo[] {
	return tryListCuaDisplays() ?? [];
}

/**
 * True when the selector means "the primary display" (or is unset).
 */
export function isPrimarySelector(selector: string | undefined): boolean {
	const wanted = selector?.trim().toLowerCase();
	return !wanted || wanted === "primary" || wanted === "main";
}
