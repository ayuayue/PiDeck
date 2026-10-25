/**
 * 输入预测的纯策略（渲染层）：文本净化、可见性、采纳键。
 *
 * 全部与 React 无关，便于单测——「什么时候把预测画到输入框里 / 哪个键算采纳」
 * 是产品规则，散进 JSX lambda 就等于没有可回归的判定口。
 */

import { PROMPT_SUGGESTION_MAX_CHARS } from "../../../shared/types/promptSuggestion";

const WRAPPING_QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g;
/** 模型偶尔会加上列表符号/编号（「1. 」「- 」），这些不是用户想输入的内容。 */
const LEADING_MARKER = /^(?:[-*•]\s+|\d+[.、)]\s+)/;

/**
 * 模型输出 → 可展示的草稿。
 *
 * 模型经常违反「只输出一句话」：包引号、换行、编号、多段解释。这里只保留第一句
 * （换行即截断，多句仍留在同一行时按句号截断），再按 200 字符上限裁剪；裁剪按码点
 * 而非 UTF-16 单元，避免把 emoji/生僻汉字劈成半个代理对。
 */
export function normalizePromptSuggestion(raw: string): string {
	const firstLine = raw.trim().split(/\r?\n/, 1)[0] ?? "";
	let text = firstLine.trim().replace(LEADING_MARKER, "").replace(WRAPPING_QUOTES, "").trim();
	// 同一行里显式多句：只留第一句（句末标点后紧跟空格/文字的续写一律丢弃）。
	const sentenceEnd = text.search(/[。！？!?]\s*[^\s。！？!?]/);
	if (sentenceEnd >= 0) text = text.slice(0, sentenceEnd + 1).trim();
	text = text.replace(/\s+/g, " ").trim();
	if (text.length <= PROMPT_SUGGESTION_MAX_CHARS) return text;
	let clipped = text.slice(0, PROMPT_SUGGESTION_MAX_CHARS);
	// 末尾落在高代理（`[\uD800-\uDBFF]`）时退回一位，避免渲染出替换字符。
	if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
	return clipped.trimEnd();
}

export type PromptSuggestionViewInput = {
	/** 已净化的建议文本；空串 = 没有可展示内容。 */
	text: string;
	/** 草稿是否为空：用户一开始打字就隐藏（但不清空，删空后还能再看）。 */
	draftEmpty: boolean;
	/** 本轮是否在跑：跑的时候不展示（下一轮结束会重新预测）。 */
	turnRunning: boolean;
	/** 开关 / 目标模型 / 会话切换导致不可用时一律隐藏。 */
	requestEnabled: boolean;
};

export function shouldShowPromptSuggestion(input: PromptSuggestionViewInput): boolean {
	// trim 而不是 length：模型偶尔只回空白（违反协议），画出来就是一个空 ghost。
	return input.requestEnabled && input.text.trim().length > 0 && input.draftEmpty && !input.turnRunning;
}

export type PromptSuggestionAcceptKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">;

/**
 * 采纳键：Tab 与 →（与 OpenBitFun 一致）。
 *
 * 只接受无修饰键、无 IME 合成的单键；Tab 可能被主菜单/预览 Tab 抢占，显示态必为空草稿，
 * 因此不需要再问「是否在行首/行尾」。Esc 归 dismiss，不在这里判。
 */
export function isPromptSuggestionAcceptKey(event: PromptSuggestionAcceptKeyEvent, opts: { hasSuggestion: boolean }): boolean {
	if (!opts.hasSuggestion) return false;
	if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
	return event.key === "Tab" || event.key === "ArrowRight";
}
