/**
 * Reads a panel size while react-resizable-panels is registering a Group.
 *
 * The v4 imperative handle can briefly outlive its Group registry entry during
 * a layout-tree transition (e.g. opening a document maximizes the workbench and
 * the session pane tree is re-registered). Callers keep their last known size
 * in that case instead of letting the lifecycle race crash the renderer.
 */
export type PanelPixelSizeReader = {
	getSize: () => { inPixels: number };
};

export type PanelPixelReadResult = {
	pixels: number;
	ready: boolean;
};

export function readPanelPixels(panel: PanelPixelSizeReader | null | undefined, fallback: number): PanelPixelReadResult {
	if (!panel) return { pixels: fallback, ready: false };
	try {
		const pixels = panel.getSize().inPixels;
		return typeof pixels === "number" && Number.isFinite(pixels) ? { pixels: Math.round(pixels), ready: true } : { pixels: fallback, ready: false };
	} catch {
		return { pixels: fallback, ready: false };
	}
}
