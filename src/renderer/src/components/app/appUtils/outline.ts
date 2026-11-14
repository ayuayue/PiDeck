/**
 * 从 AppUtils 拆出的「会话大纲」域：定位轴条目（一条用户提问一根刻度）。
 */

import type { ChatMessage } from "../../../../../shared/types";
import { replaceExpandedRefBlocksWithLabels } from "../../session/composer/quoteChip";
import { formatTime, summarizeMessage } from "./textFormat";

/* ── 会话大纲 ── */

export type OutlineItem = {
	id: string;
	entryId?: string;
	role: string;
	title: string;
	time: string;
};

/**
 * 会话定位轴条目：**一条用户提问一根**，助手回复不进刻度。
 *
 * 2026-11 真机反馈：「显示的太多了，还是回复，只显示用户的消息」。此前是「一轮两条」
 * （提问 + 本轮最终回答），一轮占两根，最近 30 根的窗口只装得下十几轮；助手刻度对
 * 「我在会话的哪里」没有帮助，却让同样高度里的提问密度翻倍。收成用户提问后，一根刻度
 * 就是一次提问，窗口覆盖的轮数翻倍，标题也只剩用户自己写的话。
 *
 * 助手回复本来就有同样的问题：pi 一轮里每次调工具都是一条独立 assistant 消息，按消息
 * 出刻度时一轮能冒出 4~9 根；投影层还把 thinking 内联成 <thinking> 标签混进 text
 * （2026-11：某会话 53 条助手刻度标题全部以 <thinking> 开头）。不再收助手条目，
 * 这两个问题一并消失。
 *
 * 无提问的后台唤醒回合（groupToolMessages 的 hasFinishedTurnInRun）同样不再单独成刻度：
 * 定位轴回答的是「用户问过什么」，没有提问就没有落点。
 */
export function buildOutline(messages: ChatMessage[]): OutlineItem[] {
	const items: OutlineItem[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		// 定位轴标题是纯文本出口：先折叠自包含引用块，否则标题就是 <quoted_context …>
		const title = summarizeMessage(replaceExpandedRefBlocksWithLabels(message.text));
		if (!title) continue;
		items.push({
			id: message.id,
			// 导轨目录用 entryId 对齐未加载检查点；缺 meta.entryId 的 live 消息退回 id。
			entryId: typeof message.meta?.entryId === "string" ? message.meta.entryId : undefined,
			role: message.role,
			title,
			time: formatTime(message.timestamp),
		});
	}
	return items;
}
