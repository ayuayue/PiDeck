import { desktopCapturer, nativeImage, type DesktopCapturerSource, type NativeImage } from "electron";
import { isPrimarySelector, listCuaDisplays, type CuaDisplayInfo, type CuaScreenRect } from "./CuaDisplay";

/**
 * Frame pipeline for CUA.
 *
 * Design choices validated by probe2/probe5:
 * - Use desktopCapturer with types:['screen'] (full screen), not ['window'].
 * - Use nativeImage.resize + toJPEG instead of sharp to avoid an extra dependency.
 * - Default maxLongEdge=1280 and quality=75 keeps base64 under ~190KB budget.
 *
 * Multi-monitor: the frame carries the captured display's physical rect
 * (`screenRect`) so a screenshot pixel can be converted into an absolute click
 * coordinate. Without it a 200% secondary display is unclickable by eye: the
 * image is downscaled and DIP≠physical, so nothing else in the tool surface
 * reveals where the picture sits on the virtual desktop.
 */

export type CaptureOptions = {
	/** Electron display id, a source id ("screen:0:0"), or "primary". Omit for primary. */
	displayId?: string;
	/** Resize so the longer edge is at most this many pixels. */
	maxLongEdge?: number;
	/** JPEG quality 1-100. */
	quality?: number;
};

export type Frame = {
	/** JPEG bytes. */
	data: Buffer;
	/** Base64-encoded JPEG. */
	base64: string;
	/** MIME type (image/jpeg). */
	mimeType: string;
	width: number;
	height: number;
	/** DesktopCapturerSource.id of the captured display (e.g. "screen:0:0"). */
	displayId: string;
	/** Electron display id, when the source could be paired with a display. */
	screenDisplayId?: string;
	/** Captured display rect in absolute click space (physical px, can be negative). */
	screenRect?: CuaScreenRect;
	/** DPI scale of the captured display (2 = 200%). */
	scaleFactor?: number;
	isPrimary?: boolean;
	timestampMs: number;
	durationMs: number;
};

export const DEFAULT_MAX_LONG_EDGE = 1280;
export const DEFAULT_QUALITY = 75;

/**
 * `DesktopCapturerSource.thumbnail` IS the capture: Electron scales each source
 * to fit the requested `thumbnailSize` (aspect preserved) and scales it *up*
 * when the box is larger than the screen. Requesting 1x1 therefore returns a
 * 1x1 JPEG — observed live on the 0.7.8 packaged build where `cua_capture`
 * always answered `width:1, height:1`. Requesting a huge ceiling (the old 8192)
 * fixed that but made every frame an 8K upscale that was then resized back down
 * to 1280 — double resampling, slower capture, softer image. Requesting the
 * output budget itself gives one resampling pass at the same final size, so the
 * resize step below only runs as a guard.
 */
function thumbnailRequestSize(maxLongEdge: number): number {
	return Math.max(1, Math.round(maxLongEdge));
}

/**
 * Pick the desktopCapturer source for a display selector.
 *
 * Accepts an Electron display id ("3094298054"), a source id ("screen:0:0"), or
 * "primary"/omitted. Order matters: Electron does not guarantee that `sources[0]`
 * is the primary display (on this dev box the primary is second), so "primary"
 * is matched by `display_id` instead of by index.
 */
export function selectScreenSource(sources: readonly DesktopCapturerSource[], selector: string | undefined, displays: readonly CuaDisplayInfo[]): DesktopCapturerSource {
	const wanted = selector?.trim();
	const primaryDisplay = displays.find((display) => display.isPrimary);

	if (isPrimarySelector(wanted)) {
		const match = primaryDisplay ? sources.find((source) => source.display_id === primaryDisplay.displayId) : undefined;
		const source = match ?? sources[0];
		if (!source) throw new Error("Screen source not found: primary");
		return source;
	}

	const source = sources.find((candidate) => String(candidate.id) === wanted) ?? sources.find((candidate) => candidate.display_id === wanted);
	if (!source) throw new Error(`Screen source not found: ${wanted}`);
	return source;
}

/**
 * Capture one display and produce a JPEG frame.
 */
export async function captureScreen(options: CaptureOptions = {}): Promise<Frame> {
	const start = Date.now();
	const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
	const quality = options.quality ?? DEFAULT_QUALITY;
	const displays = listCuaDisplays();

	const sources = await desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: { width: thumbnailRequestSize(maxLongEdge), height: thumbnailRequestSize(maxLongEdge) },
	});

	const source = selectScreenSource(sources, options.displayId, displays);
	const display = source.display_id ? displays.find((candidate) => candidate.displayId === String(source.display_id)) : undefined;

	let image: NativeImage = source.thumbnail;
	const originalSize = image.getSize();

	const longEdge = Math.max(originalSize.width, originalSize.height);
	if (longEdge > maxLongEdge) {
		const scale = maxLongEdge / longEdge;
		const newWidth = Math.round(originalSize.width * scale);
		const newHeight = Math.round(originalSize.height * scale);
		image = image.resize({ width: newWidth, height: newHeight, quality: "good" });
	}

	const size = image.getSize();
	const data = image.toJPEG(quality);
	const base64 = data.toString("base64");

	return {
		data,
		base64,
		mimeType: "image/jpeg",
		width: size.width,
		height: size.height,
		displayId: source.id,
		screenDisplayId: display?.displayId,
		screenRect: display?.bounds,
		scaleFactor: display?.scaleFactor,
		isPrimary: display?.isPrimary,
		timestampMs: Date.now(),
		durationMs: Date.now() - start,
	};
}

/**
 * Build a data URL from a captured frame.
 */
export function frameToDataUrl(frame: Frame): string {
	return `data:${frame.mimeType};base64,${frame.base64}`;
}

/**
 * Estimate base64 byte count for a frame.
 */
export function frameBase64Length(frame: Frame): number {
	return frame.base64.length;
}
