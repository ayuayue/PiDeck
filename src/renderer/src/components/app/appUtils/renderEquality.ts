/**
 * 从 AppUtils 拆出的「渲染等价判断」域：TurnRow / 时间线的 memo 比较入口。
 * 上游是 groupToolMessages 的全量重建；这里决定「内容没变就复用旧引用」。
 */

import type { ChatMessage } from "../../../../../shared/types";
import type { AgentRunItem, RenderMessage } from "./renderTypes";

/**
 * 生图占位消息的渲染身份：generating → error 往往只改 meta.imageGen，
 * 文本/图片/时间戳都不变。漏比这项时 reconcileRuns 会复用旧 run，
 * TurnRow memo 不重绘，界面一直停在「生图中」，直到切标签卸载重挂。
 */
function sameImageGenMetaForRender(previous: unknown, next: unknown): boolean {
	if (previous === next) return true;
	const prev = readImageGenRenderFields(previous);
	const nxt = readImageGenRenderFields(next);
	if (!prev && !nxt) return true;
	if (!prev || !nxt) return false;
	return prev.status === nxt.status && prev.prompt === nxt.prompt && prev.size === nxt.size && prev.errorDetail === nxt.errorDetail;
}

function readImageGenRenderFields(value: unknown): {
	status: string;
	prompt: string;
	size: string;
	errorDetail: string;
} | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("status" in value) || !("prompt" in value)) return null;
	const status = value.status;
	const prompt = value.prompt;
	if (typeof status !== "string" || typeof prompt !== "string") return null;
	const size = "size" in value && typeof value.size === "string" ? value.size : "";
	const errorDetail = "errorDetail" in value && typeof value.errorDetail === "string" ? value.errorDetail : "";
	return { status, prompt, size, errorDetail };
}

export function sameChatMessageForRender(previous: ChatMessage, next: ChatMessage): boolean {
	if (
		previous.id !== next.id ||
		previous.role !== next.role ||
		previous.text !== next.text ||
		previous.thinking !== next.thinking ||
		previous.timestamp !== next.timestamp ||
		// 空文本消息（纯工具回合骨架）的 stopReason 可能是唯一变化（pending→stop/toolUse），
		// 漏比较会导致 reconcileRuns 复用旧引用、最终/中间分类不更新。
		previous.stopReason !== next.stopReason ||
		// 模型可能在同一消息上后补（思考骨架先建、message_end 才带 provider/model），
		// 漏比较会让 reconcileRuns 复用旧引用，行头一直不显示模型。
		previous.model?.provider !== next.model?.provider ||
		previous.model?.modelId !== next.model?.modelId ||
		!sameImageGenMetaForRender(previous.meta?.imageGen, next.meta?.imageGen)
	) {
		return false;
	}
	const previousImages = previous.images ?? [];
	const nextImages = next.images ?? [];
	return (
		previousImages.length === nextImages.length &&
		previousImages.every(
			(image, index) =>
				image.mimeType === nextImages[index]?.mimeType &&
				// 历史生图图片只有 ref 引用（没有 data）：两个不同的 ref 也必须判为不等，
				// 否则换图后复用旧引用会导致时间线不刷新。
				image.ref === nextImages[index]?.ref &&
				image.data === nextImages[index]?.data,
		)
	);
}

/** `hiddenFileMessages` 的按本体比较（只喂轮末文件 chip，量小）。 */
function sameFileMessageList(previous: ChatMessage[] | undefined, next: ChatMessage[] | undefined): boolean {
	if (previous === next) return true;
	if (!previous || !next) return previous === next;
	if (previous.length !== next.length) return false;
	return previous.every((message, index) => sameChatMessageForRender(message, next[index]));
}

export function sameAgentRunForRender(previous: AgentRunItem, next: AgentRunItem): boolean {
	// 引用相同即内容相同（阶段0补强：历史 run 复用旧对象引用后，此处 O(1) 快速路径）
	if (previous === next) return true;
	if (previous.id !== next.id || previous.startedAt !== next.startedAt || previous.endedAt !== next.endedAt || previous.askWaitMs !== next.askWaitMs || previous.askPending !== next.askPending || previous.askPendingAt !== next.askPendingAt || previous.items.length !== next.items.length) {
		return false;
	}
	// hiddenFileMessages 只喂轮末「改了哪些文件」的 chip 行，不在 items 里，但同样是 run 的
	// 显示内容。漏比它会让 `hiddenFileMessages` 内容变了而整轮被判为未变 → chip 行不更新
	// （PTC 会话里 agent 静默改文件、本轮无可见文本时，用户看到的是上一轮的文件清单）。
	if (!sameFileMessageList(previous.hiddenFileMessages, next.hiddenFileMessages)) return false;
	return previous.items.every((item, index) => {
		const other = next.items[index];
		if (!other || item.kind !== other.kind) return false;
		if (item.kind === "message" && other.kind === "message") {
			return sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "retry-group" && other.kind === "retry-group") {
			// 重试条目是同 id 原地 upsert（running→success/error 只改 meta/text），
			// 必须按消息本体比较，否则运行中→收敛的状态变化不会触发重绘。
			return item.id === other.id && sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "error-group" && other.kind === "error-group") {
			// 错误诊断条目同样可能同 id 原地 upsert（见重试注释），按消息本体比较。
			return item.id === other.id && sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "thinking-group" && other.kind === "thinking-group") {
			return item.id === other.id && item.text === other.text && item.startedAt === other.startedAt && item.endedAt === other.endedAt;
		}
		if (item.kind === "tool-group" && other.kind === "tool-group") {
			return item.id === other.id && item.messages.length === other.messages.length && item.messages.every((message, messageIndex) => sameChatMessageForRender(message, other.messages[messageIndex]));
		}
		if (item.kind === "extension-entries" && other.kind === "extension-entries") {
			// 扩展输出组员同样按消息本体比较（appendEntry 只会追加，但合并/降级可能改写 text/meta）。
			return item.id === other.id && item.messages.length === other.messages.length && item.messages.every((message, messageIndex) => sameChatMessageForRender(message, other.messages[messageIndex]));
		}
		return false;
	});
}

export function getMultiSelectImageCaptureIds(items: RenderMessage[], selectedIds: Set<string>): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (item.kind === "message") {
			if (selectedIds.has(item.message.id)) ids.add(item.message.id);
			continue;
		}
		if (item.kind === "agent-run") {
			const hasSelectedAssistant = item.items.some((sub) => sub.kind === "message" && sub.message.role === "assistant" && selectedIds.has(sub.message.id));
			if (hasSelectedAssistant) ids.add(item.id);
		}
	}
	return ids;
}
