import { stripAnsi, stripThinkingTags } from "../TimelineFormat";
import type { MessageItem } from "./types";

/**
 * assistant 消息的可见正文：投影层会把 thinking 块内联成 <thinking> 标签混进 text，
 * 编辑场景只关心用户可见文字，先剥掉再收两端空白。
 */
export function visibleAssistantText(text: string): string {
	return stripThinkingTags(stripAnsi(text)).trim();
}

/**
 * issue #310：编辑入口的加载范围必须与保存范围一致。
 * 编辑目标 = 本轮最后一条有可见正文的 assistant 消息（跳过 thinking-only 尾巴）。
 * 编辑框初值与保存写入必须指向同一条消息；不能用聚合了全部中间回复的
 * mergedText 当初值再写回末条——否则「A → 工具 → B」原样保存会把 A 重复
 * 写进 B 的 entry，污染 JSONL 后续上下文。
 */
export function pickEditableAssistantMessage(items: MessageItem[]): MessageItem | null {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (visibleAssistantText(item.message.text)) return item;
	}
	return null;
}
