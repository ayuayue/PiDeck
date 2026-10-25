/**
 * 图片下载文件名（保存动作共用）。
 *
 * 为什么单独成模块：这条映射原先在 `imageActions`（附件图/生图）与
 * `MarkdownImageActions`（正文图）各写一份，而且**两份不一致**——前者只认
 * jpeg/webp/gif，svg/avif/bmp 会被存成 `.png`。两处都改成调用这里，避免再次分叉。
 */

/** MIME → 落盘扩展名（不认识的按 png 兜底：多数 provider 返回 PNG 字节）。 */
export function imageFileExtension(mimeType: string): string {
	const normalized = mimeType.toLowerCase();
	if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
	if (normalized.includes("webp")) return "webp";
	if (normalized.includes("gif")) return "gif";
	if (normalized.includes("svg")) return "svg";
	if (normalized.includes("avif")) return "avif";
	if (normalized.includes("bmp")) return "bmp";
	return "png";
}

/**
 * 由 alt / 文件名生成落盘名。
 * @param base 展示名（alt 或原文件名），会被裁掉路径分隔符与 Windows 非法字符。
 * @param mimeType 真实 MIME（决定扩展名，不看 URL 后缀）。
 * @param fallback 兜底名（base 为空时使用）。
 */
export function imageDownloadName(base: string, mimeType: string, fallback = "pideck-image"): string {
	const cleaned = base
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
		.trim()
		// 原名已带图片后缀时先剥掉，避免存成 `a.jpg.jpg`
		.replace(/\.(?:png|jpe?g|webp|gif|svg|avif|bmp)$/i, "")
		.slice(0, 40);
	return `${cleaned || fallback}.${imageFileExtension(mimeType)}`;
}
