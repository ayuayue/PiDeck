import { nativeImage, type WebContents } from "electron";
import { BrowserAgentError, errorMessage } from "./browserErrors";
import type { CdpSend } from "./cdpSession";
import { isRecord, readString } from "./valueRead";

export type BrowserScreenshotRequest = { maxLongEdge: number; quality: number; fullPage: boolean; clip?: { width: number; height: number } };

export type BrowserScreenshotResult = {
	base64: string;
	mimeType: "image/jpeg";
	width: number;
	height: number;
	cssWidth: number;
	cssHeight: number;
	scaleFactor: number;
	/** cdp = 当前帧；capturePage = 兜底（窗口不可见时可能是过期合成帧）。 */
	source: "cdp" | "capturePage";
	/** true = 整页超出像素预算被 clip 截断（只含顶部区域），模型不应假设看到了全页。 */
	clipped?: boolean;
};

/**
 * 截取内置浏览器当前页面并压到预算内。
 *
 * 为什么优先 CDP：PoC 实测 show:false 时 capturePage 返回过期合成帧（不含最后一次输入）；
 * CDP Page.captureScreenshot 拿当前帧，与"窗口可见时的 capturePage" SHA256 相同。
 * capturePage 仅作 CDP 不可用时的兜底，并用 source 字段告知调用方可能过期。
 */
export async function captureBrowserScreenshot(guest: WebContents, send: CdpSend, request: BrowserScreenshotRequest, viewport: { width: number; height: number }, scaleFactor: number): Promise<BrowserScreenshotResult> {
	let buffer: Buffer | null = null;
	let source: "cdp" | "capturePage" = "cdp";
	// clip（CSS px）：fullPage 超出像素预算时由 controller 计算并传入，捕获范围封顶在顶部区域。
	const clipParams = request.clip ? { clip: { x: 0, y: 0, width: request.clip.width, height: request.clip.height, scale: 1 } } : {};
	try {
		const result = await send("Page.captureScreenshot", { format: "jpeg", quality: request.quality, captureBeyondViewport: request.fullPage || Boolean(request.clip), ...clipParams });
		const data = isRecord(result) ? readString(result.data) : "";
		if (!data) throw new Error("empty screenshot payload");
		buffer = Buffer.from(data, "base64");
	} catch (error) {
		source = "capturePage";
		try {
			buffer = (await guest.capturePage()).toPNG();
		} catch (fallbackError) {
			throw new BrowserAgentError("screenshot_failed", errorMessage(fallbackError));
		}
	}
	if (!buffer || buffer.length === 0) throw new BrowserAgentError("screenshot_failed", "页面截图为空");
	let image = nativeImage.createFromBuffer(buffer);
	if (image.isEmpty()) throw new BrowserAgentError("screenshot_failed", "页面截图无法解码");
	const size = image.getSize();
	const longestEdge = Math.max(size.width, size.height);
	if (longestEdge > request.maxLongEdge) {
		const ratio = request.maxLongEdge / longestEdge;
		image = image.resize({
			width: Math.max(1, Math.round(size.width * ratio)),
			height: Math.max(1, Math.round(size.height * ratio)),
			quality: "good",
		});
	}
	const resized = image.getSize();
	const jpeg = image.toJPEG(request.quality);
	return {
		base64: jpeg.toString("base64"),
		mimeType: "image/jpeg",
		width: resized.width,
		height: resized.height,
		cssWidth: viewport.width,
		cssHeight: viewport.height,
		scaleFactor,
		source,
		clipped: Boolean(request.clip) || undefined,
	};
}
