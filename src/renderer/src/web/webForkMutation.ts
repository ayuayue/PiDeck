import type { UIMessage } from "ai";
import type { SessionRuntimeTarget } from "../../../shared/types";
import type { WebForkResult } from "./webApi";
import { uiMessageText } from "./webMessageParts";

export type { WebForkResult } from "./webApi";

/**
 * Web 端 fork 化重试（重发/编辑迁移）的纯策略层，与桌面 useSessionHistoryMutations 的
 * resolveForkEntryId / runForkMutation 同构。抽成纯函数便于单测（不依赖 React/IPC），
 * WebChatApp 只做接线和状态反馈。
 */

/** fork/clone 命令结果（与 WebServiceManager 返回的 SessionForkResult 同形）——复用 webApi 的定义。 */

/**
 * 解析 fork 锚点 entryId（同步部分）：
 * 1. UIMessage metadata.entryId（chatMessagesToUiMessages 从 ChatMessage.meta 透传）；
 * 2. 消息 id 的 "-history-" 后缀（历史恢复形态 `xxx-history-<entryId>`）；
 * 3. DSH：消息 id 形如 "dsh:<seq>"，seq 即 fork 锚点。
 * 均不命中返回 undefined，由调用方走 getForkMessages 文本回退。
 */
export function forkEntryIdFromMessage(message: UIMessage): string | undefined {
	const metadata = message.metadata as Record<string, unknown> | undefined;
	if (typeof metadata?.entryId === "string" && metadata.entryId) return metadata.entryId;
	const marker = "-history-";
	const historyIndex = message.id.lastIndexOf(marker);
	if (historyIndex >= 0) {
		const fromId = message.id.slice(historyIndex + marker.length).trim();
		if (fromId && fromId !== String(metadata?._piDeckMsgSeq ?? "") && !/^\d+$/.test(fromId)) return fromId;
	}
	const dshMatch = /^dsh:(\d+)$/.exec(message.id);
	if (dshMatch) return `seq:${dshMatch[1]}`;
	return undefined;
}

/**
 * 完整锚点解析（含文本回退）：同步策略不命中时拉 getForkMessages 列表，
 * 从尾部找文本完全相等的最近一条（同一文本可能发过多次，尾部才是用户所指的那条）。
 */
export async function resolveWebForkEntryId(message: UIMessage, target: SessionRuntimeTarget, fetchForkMessages: (target: SessionRuntimeTarget) => Promise<Array<{ entryId: string; text: string }>>): Promise<string | undefined> {
	const direct = forkEntryIdFromMessage(message);
	if (direct) return direct;
	try {
		const forkMessages = await fetchForkMessages(target);
		const targetText = uiMessageText(message).trim();
		if (!targetText || !Array.isArray(forkMessages)) return undefined;
		for (let i = forkMessages.length - 1; i >= 0; i -= 1) {
			const item = forkMessages[i];
			if (item?.entryId && item.text?.trim() === targetText) return item.entryId;
		}
	} catch {
		// 回退失败：交上层 toast（与桌面行为一致，不吞错也不中断）
	}
	return undefined;
}

/**
 * fork 锚点是否为最后一条用户消息：尾部替换（false→branchMode=false，旧会话隐藏）
 * vs 分支模式（true→branchMode=true，旧会话保留）。从消息列表尾部向前找第一条用户消息。
 */
export function isLastUserMessageIn(messages: UIMessage[], messageId: string): boolean {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i].role !== "user") continue;
		return messages[i].id === messageId;
	}
	return false;
}

/**
 * 重投递文本：编辑用新文本；重发优先 fork 返回的原文（与落盘一致），
 * 缺失时回退时间线文本。引用/图片不重建——fork 的上下文已在子会话前缀里。
 */
export function forkPromptText(kind: "edit" | "resend", result: WebForkResult, message: UIMessage, newText?: string): string {
	if (kind === "edit" && newText !== undefined) return newText;
	if (typeof result.text === "string" && result.text.length > 0) return result.text;
	return uiMessageText(message);
}
