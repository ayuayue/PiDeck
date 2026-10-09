/**
 * 导入会话写成 pi JSONL 时的字段归一：stopReason、未知块、图片体积。
 * 投影层只认正规 pi 文件，源差异全部在这里收口。
 */

export type ImportedStopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

export type ImportedTextBlock = { type: "text"; text: string };
export type ImportedImageBlock = { type: "image"; data: string; mimeType: string };
export type ImportedContentBlock = ImportedTextBlock | ImportedImageBlock;

/** 约 256KB 二进制；超过则改占位，避免导入把大 base64 打进会话 JSONL。 */
export const IMPORTED_IMAGE_MAX_BASE64_CHARS = 350_000;

/** OpenCode / ZCode 过程噪声：不是对话内容，导入时丢掉。 */
export const IMPORTED_SKIP_PART_TYPES = new Set(["step-start", "step-finish", "timeline", "snapshot", "patch", "compaction"]);

export function importedContentHasToolCall(content: unknown[]): boolean {
	return content.some((item) => isRecord(item) && item.type === "toolCall");
}

/**
 * 有 toolCall 就是 toolUse。否则把源枚举映射到 pi：
 * end_turn/stop → stop，tool-calls/tool_use → toolUse，max_tokens → length。
 */
export function normalizeImportedStopReason(input: { raw?: unknown; hasToolCall: boolean }): ImportedStopReason {
	if (input.hasToolCall) return "toolUse";
	const raw = String(input.raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
	if (!raw || raw === "stop" || raw === "end-turn" || raw === "endturn" || raw === "unknown" || raw === "complete" || raw === "completed") {
		return "stop";
	}
	if (raw === "tooluse" || raw === "tool-use" || raw === "tool-calls" || raw === "toolcall") {
		return "toolUse";
	}
	if (raw === "max-tokens" || raw === "length" || raw === "max-length") return "length";
	if (raw === "error") return "error";
	if (raw === "aborted" || raw === "abort" || raw === "cancelled" || raw === "canceled") {
		return "aborted";
	}
	return "stop";
}

export function importedUnknownBlockAsText(block: unknown): ImportedTextBlock {
	try {
		return { type: "text", text: JSON.stringify(block) };
	} catch {
		return { type: "text", text: String(block) };
	}
}

export function importedImagePlaceholder(label: string): ImportedTextBlock {
	const name = label.replace(/\s+/g, " ").trim() || "image";
	return { type: "text", text: `[image: ${name}]` };
}

export function importedAttachmentPlaceholder(label: string): ImportedTextBlock {
	const name = label.replace(/\s+/g, " ").trim() || "attachment";
	return { type: "text", text: `[attachment: ${name}]` };
}

export function capImportedImage(image: ImportedImageBlock, label: string): ImportedContentBlock {
	if (image.data.length <= IMPORTED_IMAGE_MAX_BASE64_CHARS) return image;
	return importedImagePlaceholder(label);
}

/**
 * 识别 image / input_image / 带 image mime 的 file。
 * 有小图字节就写成 pi image；没有字节或过大则占位。不是图片块返回 null。
 */
export function tryImportedImageBlock(block: unknown): ImportedContentBlock | null {
	if (!isRecord(block)) return null;
	const type = String(block.type ?? "");
	const mime = String(block.mimeType ?? block.mime_type ?? block.mime ?? "");
	const source = isRecord(block.source) ? block.source : undefined;
	const sourceMime = String(source?.media_type ?? source?.mimeType ?? "");
	const looksLikeImage = type === "image" || type === "input_image" || (type === "file" && mime.startsWith("image/"));
	if (!looksLikeImage) return null;

	const label = String(block.filename ?? block.name ?? block.url ?? (mime || sourceMime || "image"));
	const data = extractImportedImageData(block);
	if (!data) return importedImagePlaceholder(label);
	return capImportedImage({ type: "image", data, mimeType: mime || sourceMime || "image/png" }, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractImportedImageData(record: Record<string, unknown>): string {
	if (typeof record.data === "string") return stripDataUrl(record.data);
	const source = isRecord(record.source) ? record.source : undefined;
	if (typeof source?.data === "string") return stripDataUrl(source.data);
	if (typeof record.url === "string" && record.url.startsWith("data:")) return stripDataUrl(record.url);
	return "";
}

function stripDataUrl(value: string): string {
	const trimmed = value.trim();
	const match = trimmed.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/i);
	return (match ? match[1] : trimmed).replace(/\s+/g, "");
}

/**
 * 外部会话源的时间戳转 ISO 串。
 * 畸形值（NaN/±Infinity/超 ±8.64e15 的 1e300 等）会产出 Invalid Date，
 * `toISOString()` 抛 RangeError 且被 scan 的 Promise.all 放大成整列表失败
 * （2026-03 导入器审计实测）；这里回退 epoch，单条消息时间戳错好过整个会话不可导入。
 */
export function safeIsoTimestamp(value: number | string | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "1970-01-01T00:00:00.000Z";
	return date.toISOString();
}
