/**
 * webImageCompress — 浏览器端图片压缩（P2 图片收发）。
 *
 * 发送前把任意图片压到 maxDim 1568px / JPEG q=0.85（与移动端习惯一致），
 * 保证 /api/chat 的 JSON body（上限 8MB）不被原图撑爆。纯浏览器 API，
 * 不依赖 Electron/Node，桌面内置预览与远程浏览器同样可用。
 */

const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 0.85;

/** 压缩 File/Blob 为 JPEG data URL；失败（如浏览器不支持 createImageBitmap）时回退 FileReader 原样 base64。 */
export async function compressImageToDataUrl(file: Blob): Promise<string> {
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("canvas 2d unavailable");
		context.drawImage(bitmap, 0, 0, width, height);
		bitmap.close();
		return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
	} catch {
		// createImageBitmap 不可用（老浏览器）或解码失败：回退原样读 base64。
		return await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error ?? new Error("read failed"));
			reader.readAsDataURL(file);
		});
	}
}

/** 从粘贴事件提取图片文件（clipboardData.items type image/*）。 */
export function imagesFromPasteEvent(event: ClipboardEvent): File[] {
	const files: File[] = [];
	const items = event.clipboardData?.items;
	if (!items) return files;
	for (const item of Array.from(items)) {
		if (item.kind === "file" && item.type.startsWith("image/")) {
			const file = item.getAsFile();
			if (file) files.push(file);
		}
	}
	return files;
}
