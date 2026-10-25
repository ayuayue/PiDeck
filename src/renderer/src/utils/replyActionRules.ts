import type { ChatMessage } from "../../../shared/types";
import type { ReplyActionRule, ReplyActionTrigger } from "../../../shared/types/replyActions";
import { stripThinkingTags } from "../components/session/TimelineFormat";

/**
 * 声明式规则的信号求值（纯函数，无 React 依赖，可单测）。
 *
 * 渲染层把「最新一轮回复」归约成两个信号，再与用户规则逐条求值：
 * - failed：本轮以失败收场（请求级错误 / stopReason 表明中断）——工具/扩展自身报错不算；
 * - finalText：本轮最终助手回复的自然语言文本（剥掉思考标签与代码块）。
 * 内置的提交/推送意图推断已不再写死在这里：出厂规则资源里以 textMatch 规则表达，
 * 用户可以增删改同样的结构。
 */

/** 与旧实现同一组请求失败 i18n key（诊断消息承担「整轮失败」语义） */
const REQUEST_FAILURE_KEYS = new Set(["diagnostic.requestFailed", "diagnostic.requestFailedAfterRetries", "diagnostic.requestFailedUnknown", "diagnostic.requestFailedUnknownAfterRetries", "diagnostic.retryFailed"]);
/** 自动重试已排程：本轮还没结束，不展示任何建议 */
const RETRY_PENDING_KEYS = new Set(["diagnostic.retryScheduled", "diagnostic.retryScheduledAfterDelay"]);

/** 最新一轮的信号（倒查到 user 消息为止）；本轮为空时 signals 为 null。 */
export type ReplySignals = {
	/** 本轮以失败收场 */
	failed: boolean;
	/** 本轮正常收场（有助手结语文本且未失败） */
	stopped: boolean;
	/** 最终回复的自然语言文本（失败轮为空串） */
	finalText: string;
};

/** 把消息倒查归约成信号；返回 null 表示当前没有可归约的完整轮次（运行中/空会话）。 */
export function replySignalsForMessages(messages: readonly ChatMessage[]): ReplySignals | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role === "user") return null;
		if (message.role === "error" || message.role === "system") {
			const key = message.meta?.i18nKey;
			if (typeof key === "string" && RETRY_PENDING_KEYS.has(key)) return null;
			if (typeof key === "string" && REQUEST_FAILURE_KEYS.has(key)) return { failed: true, stopped: false, finalText: "" };
			continue;
		}
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return { failed: true, stopped: false, finalText: "" };
		if (message.stopReason === "aborted" || message.stopReason === "length") {
			return { failed: false, stopped: false, finalText: "" };
		}
		if (message.stopReason && message.stopReason !== "stop") return null;
		const text = stripThinkingTags(message.text).trim();
		if (!text) return null;
		return { failed: false, stopped: true, finalText: text };
	}
	return null;
}

/** 剥离围栏代码块与行内代码——与 commitIntentSuggestions 同判据：代码里的词不代表意图。 */
function stripCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** 单条 trigger 求值；正则解析失败按「永不命中」处理（用户手写坏正则不能弄崩会话页）。 */
function triggerMatches(trigger: ReplyActionTrigger, signals: ReplySignals, proseText: string): boolean {
	// always：新一轮收场后就显示，不挑成功/失败/中止。signals 为 null（运行中）时整体仍不出。
	if (trigger.kind === "always") return true;
	if (trigger.kind === "onFailure") return signals.failed;
	if (trigger.kind === "onStop") return signals.stopped;
	const compiled = compilePatterns(trigger.patterns ?? []);
	return compiled.some((pattern) => pattern.test(proseText));
}

/** 预编译正则：坏的 pattern 丢弃而不是抛错（缓存编译结果避免每次渲染重编译）。 */
const patternCache = new Map<string, RegExp | null>();
function compilePatterns(patterns: readonly string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		let regex = patternCache.get(pattern);
		if (regex === undefined) {
			try {
				regex = new RegExp(pattern, "i");
			} catch {
				regex = null;
			}
			patternCache.set(pattern, regex);
		}
		if (regex) compiled.push(regex);
	}
	return compiled;
}

/** 信号 × 规则 → 建议文案列表（保持规则文件里的顺序；全部命中 triggers 才展示）。 */
export function replyActionsForSignals(rules: readonly ReplyActionRule[], signals: ReplySignals | null): string[] {
	if (!signals) return [];
	const prose = stripCode(signals.finalText);
	const texts: string[] = [];
	const seen = new Set<string>();
	for (const rule of rules) {
		if (seen.has(rule.text)) continue;
		if (!rule.triggers.every((trigger) => triggerMatches(trigger, signals, prose))) continue;
		seen.add(rule.text);
		texts.push(rule.text);
	}
	return texts;
}

/**
 * 同步内置规则：text 相同的条目触发条件跟内置走（出厂优化后老用户点「同步内置」
 * 才能拿到新 patterns——旧版只追加缺项，同文案条目的 triggers 永远停在首次 seed）；
 * 内置没有的条目原样保留，内置新增的追加到末尾，顺序以个人清单为准。
 */
export function mergeReplyActionRules(current: readonly ReplyActionRule[], defaults: readonly ReplyActionRule[]): ReplyActionRule[] {
	const byText = new Map(defaults.map((rule) => [rule.text, rule]));
	const synced = current.map((rule) => byText.get(rule.text) ?? rule);
	const known = new Set(current.map((rule) => rule.text));
	const additions = defaults.filter((rule) => !known.has(rule.text));
	return [...synced, ...additions];
}

/** 便捷入口：消息 → 建议文案（SessionReplyActions 直接用）。 */
export function replyActionTextsForMessages(rules: readonly ReplyActionRule[], messages: readonly ChatMessage[]): string[] {
	return replyActionsForSignals(rules, replySignalsForMessages(messages));
}
