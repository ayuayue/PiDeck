import { Ban, PencilLine } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";

/**
 * 「这条消息在模型上下文里的状态」标记。
 *
 * 背景：pi 用追加的 `context_edit` 记录表达「把某条消息移出/改写模型上下文」，
 * 原始行不动、费用不回退、已被压缩摘要转述的内容也删不掉。因此界面上必须把
 * 「原始历史」与「模型下次能看到的内容」分开说清楚：
 *   - 已移出上下文：消息照常显示（原文可查），加一个可 hover 的标记说明它不再入模型；
 *   - 上下文已改写：显示的是原文，标记说明模型看到的是改后的内容。
 *
 * 为什么不把这类消息隐藏或折叠成占位：那会让用户以为「删除＝彻底忘掉 / 省钱」，
 * 而这正是 pi 语义下最容易误解的地方（真实行为只是下次请求不再带上）。
 */
export function ContextEditBadge(props: { message: ChatMessage; className?: string }) {
	const state = readContextEditState(props.message);
	if (!state) return null;
	const isExcluded = state === "excluded";
	const Icon = isExcluded ? Ban : PencilLine;
	const label = isExcluded ? t("timeline.contextExcluded") : t("timeline.contextReplaced");
	const hint = isExcluded ? t("timeline.contextExcludedHint") : t("timeline.contextReplacedHint");
	return (
		<span role="note" title={hint} data-context-edit={state} className={cn("inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-subtle bg-bg-subtle px-1.5 py-0.5 text-micro font-normal text-text-tertiary", props.className)}>
			<Icon size={11} strokeWidth={1.8} aria-hidden="true" />
			{label}
		</span>
	);
}

/** 读取消息上的上下文编辑标记；无标记/未知值返回 undefined（老消息零影响）。 */
export function readContextEditState(message: ChatMessage): "excluded" | "replaced" | undefined {
	const value = message.meta?.contextEdit;
	return value === "excluded" || value === "replaced" ? value : undefined;
}
