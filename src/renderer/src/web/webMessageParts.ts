import type { UIMessage } from "ai";

/**
 * UIMessage part 提取纯函数（纯叶子模块，无 React/别名依赖——vm 沙箱单测可用）。
 * WebTimeline 与 webForkMutation 共用；从 WebTimeline 抽出避免策略层反向依赖组件模块。
 */

/** UIMessage.metadata 是 unknown：统一在这里收窄，避免各调用点各自 as。 */
function uiMessageMetadata(message: UIMessage): Record<string, unknown> | undefined {
	const metadata = (message as { metadata?: unknown }).metadata;
	return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : undefined;
}

/** 消息墙钟时间（历史行由 chatMessagesToUiMessages 写入；实时消息由流帧/本地发送时补上）。 */
export function uiMessageTimestamp(message: UIMessage): number | undefined {
	const value = uiMessageMetadata(message)?.timestamp;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 消息结束时间：优先主进程写入的 meta.endedAt（pi 终态实测耗时），缺失回退时间戳。 */
export function uiMessageEndedAt(message: UIMessage): number | undefined {
	const endedAt = uiMessageMetadata(message)?.endedAt;
	if (typeof endedAt === "number" && Number.isFinite(endedAt) && endedAt > 0) return endedAt;
	return uiMessageTimestamp(message);
}

/** 本条 assistant 消息实际使用的模型（历史消息自带；实时链路结算后由历史重拉补齐）。 */
export function uiMessageModel(message: UIMessage): { provider: string; modelId: string } | undefined {
	const value = uiMessageMetadata(message)?.model;
	if (!value || typeof value !== "object") return undefined;
	const { provider, modelId } = value as { provider?: unknown; modelId?: unknown };
	return typeof provider === "string" && provider && typeof modelId === "string" && modelId ? { provider, modelId } : undefined;
}

/** 从 UIMessage 提取纯文本（复制/重发用）。 */
export function uiMessageText(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

/** 提取消息中的图片 data URL（用户气泡缩略图 / 重发附件）。 */
export function uiMessageImages(message: UIMessage): string[] {
	const urls: string[] = [];
	for (const part of message.parts) {
		if (part.type !== "file") continue;
		const filePart = part as { mediaType?: string; data?: string; url?: string };
		const src = typeof filePart.data === "string" ? filePart.data : typeof filePart.url === "string" ? filePart.url : "";
		if (src && (!filePart.mediaType || filePart.mediaType.startsWith("image/"))) urls.push(src);
	}
	return urls;
}

/**
 * 图片 data URL → AI SDK file part：图片附件必须以 file parts 随 user 消息提交——
 * 服务端 /api/chat 只从消息 parts 提取图片（extractChatImages），uiMessageImages 也
 * 只认 parts 渲染气泡缩略图。mediaType 从 data URL 前缀解析，失败按 png 兜底
 * （webImageCompress 只产出 png/jpeg/webp）。
 */
export function dataUrlToFilePart(dataUrl: string): { type: "file"; mediaType: string; url: string } {
	const mediaType = /^data:([^;]+)[;,]/.exec(dataUrl)?.[1] ?? "image/png";
	return { type: "file", mediaType, url: dataUrl };
}
