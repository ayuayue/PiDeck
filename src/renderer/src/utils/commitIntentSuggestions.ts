import type { AgentRunItem } from "../components/app/AppUtils";
import { stripThinkingTags } from "../components/session/TimelineFormat";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";

/**
 * 「提交/推送」快捷建议的意图检测（纯函数，无 React 依赖，可单测）。
 *
 * 判据：本轮 run 的最终 assistant 回复（stopReason === "stop"，缺失时回退
 * run 内最后一条非空 assistant 文本）里是否提到提交/推送；命中即给出固定
 * 两条建议（提交 / 提交并推送）。代码块与行内代码先剥掉——模型展示
 * `git commit -m ...` 示例或 diff 上下文里的 "commit" 不代表它在建议用户
 * 提交，误命中比漏命中更扰民。
 */

export type CommitSuggestion = {
	/** 稳定 key：同时用作 i18n label/text 后缀 */
	id: "commit" | "commitPush";
	/** 点击后直接发送的消息正文（i18n key） */
	textKey: TranslationKey;
	labelKey: TranslationKey;
};

export const COMMIT_SUGGESTIONS: CommitSuggestion[] = [
	{ id: "commit", textKey: "commitSuggest.commitText", labelKey: "commitSuggest.commit" },
	{ id: "commitPush", textKey: "commitSuggest.commitPushText", labelKey: "commitSuggest.commitPush" },
];

/** 取一轮 run 的最终回复文本；本轮还没有落定的最终回复时返回 undefined。 */
export function finalAssistantText(run: AgentRunItem | undefined): string | undefined {
	if (!run) return undefined;
	let fallback: string | undefined;
	for (let i = run.items.length - 1; i >= 0; i -= 1) {
		const item = run.items[i];
		if (item.kind !== "message" || item.message.role !== "assistant") continue;
		const text = stripThinkingTags(item.message.text ?? "").trim();
		if (!text) continue;
		// stopReason 是首选判据；历史数据缺失时回退「最后一条非空 assistant」。
		if (item.message.stopReason === "stop") return text;
		if (item.message.stopReason === "toolUse" || item.message.stopReason === "pending") continue;
		fallback ??= text;
	}
	return fallback;
}

/** 剥离围栏代码块与行内代码，只留自然语言正文。 */
function stripCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

// 中文「提交」排掉 git 语义外的固定搭配（提交节点/锁/表单/调度器等通用词），
// 宁可漏判也不在无关回复里冒泡；英文 commit 用 ASCII 词边界。
const NON_GIT_COMMIT_SUFFIX = "(?!节点|锁|表单|申请|调度|队列|作业|任务|流程|审批|请求|物化|视图)";
const COMMIT_PATTERNS: RegExp[] = [new RegExp(`提交${NON_GIT_COMMIT_SUFFIX}`), /(?<![a-z0-9])commit(?![a-z0-9])/i];
// 推送意图要求 git 语境同现（远程/origin/分支/改动…）；裸 "push"「推送」
// 与产品语境的「推送消息/推送通知」歧义太大，不做无上下文匹配。
// 「催更」是中文开发者社区对 push 的常用俗称，无需额外上下文。
const GIT_PUSH_CONTEXT = "(?:远程|远端|origin|仓库|代码|改动|分支|main|dev)";
const PUSH_PATTERNS: RegExp[] = [/催更/, new RegExp(`推(?:送)??.{0,8}${GIT_PUSH_CONTEXT}`), new RegExp(`${GIT_PUSH_CONTEXT}.{0,8}推`), /(?<![a-z0-9])(?:git\s+)?push(?:es)?\s+(?:to\s+)?[a-z0-9/_-]*(?:origin|remote|main|dev|branch)/i];

function matchesAny(patterns: RegExp[], text: string): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

/** 从最终回复文本检测「建议提交/推送」的意图。 */
export function hasCommitIntent(text: string | undefined): boolean {
	if (!text) return false;
	const prose = stripCode(text);
	return matchesAny(COMMIT_PATTERNS, prose) || matchesAny(PUSH_PATTERNS, prose);
}

/** run → 固定建议列表；无意图时返回空数组（调用方据此不渲染）。 */
export function commitSuggestionsForRun(run: AgentRunItem | undefined): CommitSuggestion[] {
	return hasCommitIntent(finalAssistantText(run)) ? COMMIT_SUGGESTIONS : [];
}
