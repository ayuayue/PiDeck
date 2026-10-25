/**
 * webClipboard — Web 端剪贴板写入（带 execCommand 兜底）。
 *
 * LAN 场景多为 http 非安全上下文，navigator.clipboard 为 undefined；
 * 回退到隐藏 textarea + document.execCommand("copy")（旧但全覆盖）。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (navigator.clipboard && window.isSecureContext) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// 权限拒绝等 → 走兜底
		}
	}
	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.setAttribute("readonly", "true");
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand("copy");
		textarea.remove();
		return ok;
	} catch {
		return false;
	}
}

/** 图片压缩参数（与桌面发送管线同量级）：最长边 1568px、JPEG 85%。 */
const IMAGE_MAX_EDGE = 1568;
const IMAGE_JPEG_QUALITY = 0.85;

export type WebAttachedImage = {
	/** data URL（data:image/jpeg;base64,…），直接用于预览与发送 */
	dataUrl: string;
	/** 原文件名（仅展示） */
	name: string;
};

/** File → 压缩 data URL。非图片或解码失败返回 undefined（调用方跳过）。 */
export async function compressImageFile(file: File): Promise<WebAttachedImage | undefined> {
	if (!file.type.startsWith("image/")) return undefined;
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) return undefined;
		context.drawImage(bitmap, 0, 0, width, height);
		bitmap.close();
		return { dataUrl: canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY), name: file.name || "image" };
	} catch {
		return undefined;
	}
}
