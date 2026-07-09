export type SendShortcut =
	| "enter-send"
	| "ctrl-enter-send"
	| "shift-enter-send";

export type ComposerEnterIntent = "ignore" | "newline" | "send";

import type { ComposerAgentMode } from "@shared/types";

export const PI_DECK_PLAN_MODE_MARKER = "__PI_DECK_PLAN_MODE__";

export type ComposerPromptSubmission = {
	/** 用户在 PiDeck 时间线里看到的原始消息，不能包含桌面端内部控制标记。 */
	message: string;
	/** 仅发给 pi agent/extension 的隐藏消息，用于触发桌面端专属模式。 */
	agentMessage?: string;
};

/**
 * 构造发送给主进程的 composer 快照。
 * Plan 模式依赖 PiDeck 内置 extension 在 pi 的 input 事件里识别隐藏标记；
 * 用户可见消息保持原文，避免会话时间线出现实现细节或控制 token。
 */
/**
 * Prompt Template 类型，与 App.tsx 中 promptTemplateList 类型一致。
 */
export type PromptTemplateInfo = {
	name: string;
	path: string;
	description: string;
	content: string;
};

/**
 * 展开消息中的 prompt template 命令（/templateName）。
 *
 * 在发送到 pi 之前本地展开模板内容，避免依赖 pi 的展开机制导致：
 * - 用户附加在命令后的文本丢失（pi 仅替换命令，丢弃后续输入）
 * - 模板内容中的特殊符号（frontmatter delimiters、XML 标签等）
 *   与用户文本拼接时串格式
 *
 * 边界处理：
 * - 按 name 长度降序匹配，避免短名称误吃长名称的前缀
 * - 只匹配后跟空格或行尾的 /name，防止部分匹配
 * - 单次正则遍历，不会级联展开替换后的内容
 * - 未找到的模板名保持原样，由 pi 兜底处理
 */
export function expandPromptTemplates(
	message: string,
	templates: PromptTemplateInfo[],
): string {
	if (!templates.length || !message.includes("/")) return message;

	// 按 name 长度降序排序，确保正则交替时最长匹配优先
	const sorted = [...templates].sort((a, b) => b.name.length - a.name.length);
	const nameToContent = new Map(sorted.map((t) => [t.name, t.content]));

	// 构建 /name1|/name2|/name3 的单一正则，捕获命令前后的空白分隔符
	const escapedNames = sorted.map((t) =>
		t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	);
	const regex = new RegExp(
		`(^|\\s)/(${escapedNames.join("|")})(\\s|$)`,
		"g",
	);

	return message.replace(regex, (_match, prefix, name, suffix) => {
		const content = nameToContent.get(name) ?? "/" + name;
		// 命令后有用户输入时用两个换行分隔模板内容和用户输入，提升可读性
		const separator = suffix && /\s/.test(suffix) ? "\n\n" : "";
		return prefix + content + separator;
	});
}


export function buildComposerPromptSubmission(
	message: string,
	mode: ComposerAgentMode,
): ComposerPromptSubmission {
	if (mode !== "plan") return { message };

	// 斜线命令原样发送，让 pi 解析执行——plan 模式下也能用 /plan off、/todos 等，
	// 否则 plan 标记前缀会让 "/plan off" 变成普通消息发给 LLM，命令无法触发。
	const trimmed = message.trim();
	if (trimmed.startsWith("/")) return { message };

	const visibleInstruction = trimmed || "请根据已附加的图片或上下文先制定实施计划。";
	return {
		message,
		agentMessage: [
			PI_DECK_PLAN_MODE_MARKER,
			visibleInstruction,
			"",
			"请先只做只读分析，不要修改文件。最后必须输出以 `Plan:` 开头的编号计划，格式如下：",
			"Plan:",
			"1. 第一步",
			"2. 第二步",
		].join("\n"),
	};
}

type ComposerKeyboardState = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
	keyCode?: number;
	which?: number;
	nativeEvent?: {
		isComposing?: boolean;
		keyCode?: number;
		which?: number;
	};
};

/**
 * 归一化输入框 Enter 键意图，避免 React 组件里散落快捷键判断。
 * IME 回车确认会先发出 composing 状态的 Enter，这时必须交给输入法处理，
 * 否则中文输入法里选择英文候选也会被误判为发送消息。
 */
export function getComposerEnterIntent(
	event: ComposerKeyboardState,
	sendShortcut: SendShortcut,
): ComposerEnterIntent {
	if (event.key !== "Enter") return "ignore";
	if (isComposingInput(event)) return "ignore";

	const shouldSend =
		sendShortcut === "enter-send"
			? !event.ctrlKey && !event.metaKey && !event.shiftKey
			: sendShortcut === "ctrl-enter-send"
				? event.ctrlKey || event.metaKey
				: event.shiftKey;

	if (shouldSend) return "send";
	return "newline";
}

function isComposingInput(event: ComposerKeyboardState) {
	// Shift+Enter 不可能是 IME 合成，直接跳过检测
	if (event.shiftKey) return false;
	// keyCode/which=229 是部分 Chromium/macOS 输入法在 composition 期间的兼容信号。
	return Boolean(
		event.isComposing ||
			event.nativeEvent?.isComposing ||
			event.key === "Process" ||
			event.keyCode === 229 ||
			event.which === 229 ||
			event.nativeEvent?.keyCode === 229 ||
			event.nativeEvent?.which === 229,
	);
}
