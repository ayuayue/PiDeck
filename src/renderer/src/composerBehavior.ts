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
	argumentHint?: string;
};

/** 从 frontmatter 中提取 argument-hint 元数据 */
export function parseArgumentHint(content: string): string | undefined {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return undefined;
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		if (key === "argument-hint") {
			return line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
		}
	}
	// 兜底：从内容正文中扫描 ${name} / ${name:default} 模式，按首次出现顺序推断提示
	return scanArgumentHintFromBody(content);
}

/** 从内容正文中扫描 ${var} / ${var:default} 模式生成 argument-hint 兜底 */
function scanArgumentHintFromBody(content: string): string | undefined {
	// 去掉 frontmatter 部分
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	const seen = new Map<string, { hasDefault: boolean; defaultVal?: string }>();
	const regex = /\$\{([a-zA-Z_]\w*)(?::(.*?))?\}/g;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(body)) !== null) {
		const name = m[1];
		if (!seen.has(name)) {
			seen.set(name, {
				hasDefault: m[2] !== undefined,
				defaultVal: m[2],
			});
		}
	}
	if (seen.size === 0) return undefined;
	const hints: string[] = [];
	// 按首次出现顺序输出
	for (const [name, info] of seen) {
		if (info.hasDefault) {
			hints.push(`[${name}:${info.defaultVal}]`);
		} else {
			hints.push(`<${name}>`);
		}
	}
	return hints.join(" ");
}

/** 内置 prompt 模板的中文 description 映射 */
const BUILTIN_PROMPT_DESC_CN: Record<string, string> = {
	review: "审查暂存的 Git 更改，检查 bug、安全问题和逻辑错误",
	test: "为函数或组件编写全面的测试用例",
	fix: "调试并修复问题，包含根因分析",
	refactor: "重构代码以提升可读性和可维护性",
	doc: "添加或改进文档和注释",
explain: "用简洁的语言解释代码或架构",
	commit: "根据暂存更改生成约定式提交信息",
	"pi-system": "查看 pi 的默认系统提示词（身份、工具、行为准则）",
	"skill-discipline": "技能执行纪律：何时及如何触发 agent 技能的规则",
};

/** 内置 prompt 模板的英文 description 映射（fallback） */
const BUILTIN_PROMPT_DESC_EN: Record<string, string> = {
	review: "Review staged git changes for bugs, security issues, and logic errors",
	test: "Write tests for a function or component covering edge cases",
	fix: "Debug and fix issues with root cause analysis",
	refactor: "Refactor code for better readability and maintainability",
	doc: "Add or improve documentation and comments",
	explain: "Explain code or architecture in simple terms",
	commit: "Generate a conventional commit message from staged changes",
	"pi-system": "View pi's default system prompt (identity, tools, guidelines)",
	"skill-discipline": "Skills execution discipline: rules for when and how to trigger agent skills",
};

/**
 * 翻译内置 prompt 模板的 description（UI 展示用）。
 * 非内置模板保持原样。
 */
export function translateBuiltinPromptDescription(
	template: PromptTemplateInfo,
): string {
	if (!template.path.startsWith("builtin://")) return template.description;
	// 根据 html[data-theme] 判断语言环境——中文用 CN 映射，其余用 EN
	const isChinese =
		typeof document !== "undefined" &&
		document.documentElement.lang?.startsWith("zh");
	const map = isChinese ? BUILTIN_PROMPT_DESC_CN : BUILTIN_PROMPT_DESC_EN;
	return map[template.name] ?? template.description;
}

/** 移除 markdown frontmatter 块（--- 包裹的元数据），仅返回正文。
 *  prompt 模板的 content 包含完整原始内容（含 frontmatter），
 *  展开时需剥离 frontmatter，避免 `---\ndescription: xxx\n---` 污染对话消息。 */
function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

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
 * - 展开时剥离 content 中的 frontmatter，避免元数据泄漏到对话消息中
 */
export function expandPromptTemplates(
	message: string,
	templates: PromptTemplateInfo[],
): { message: string; description?: string } {
	if (!templates.length || !message.includes("/")) return { message };

	// 按 name 长度降序排序，确保正则交替时最长匹配优先
	const sorted = [...templates].sort((a, b) => b.name.length - a.name.length);
	const nameToContent = new Map(sorted.map((t) => [t.name, t.content]));
	const nameToDescription = new Map(sorted.map((t) => [t.name, t.description]));

	// 记录最后匹配到的模板名，用于提取 description 作为元数据发送给 pi agent
	let matchedName: string | undefined;

	// 构建 /name1|/name2|/name3 的单一正则，捕获命令前后的空白分隔符
	const escapedNames = sorted.map((t) =>
		t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	);
	const regex = new RegExp(
		`(^|\\s)/(${escapedNames.join("|")})(\\s|$)`,
		"g",
	);

	const expanded = message.replace(regex, (_match, prefix, name, suffix) => {
		matchedName = name;
		const rawContent = nameToContent.get(name) ?? "/" + name;
		// 剥离 content 中的 frontmatter 元数据，只保留正文，
		// 避免 `---\ndescription: xxx\n---` 泄漏到 pi agent 的对话消息中。
		const content = stripFrontmatter(rawContent);
		// 命令后有用户输入时用两个换行分隔模板内容和用户输入，提升可读性
		const separator = suffix && /\s/.test(suffix) ? "\n\n" : "";
		return prefix + content + separator;
	});

	return {
		message: expanded,
		description: matchedName ? nameToDescription.get(matchedName) : undefined,
	};
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

/**
 * 解析历史导航应该快照的 composer 草稿。
 *
 * 业务背景：普通键盘输入只更新 livePromptByAgentRef，不会触发 App 重渲染；
 * 因此 ArrowUp 闭包里的 renderedPrompt 可能停留在上次 chips/空状态翻转时。
 * 必须优先读 live ref，否则按上键再按下键时会丢掉中间继续输入的部分。
 */
export function resolveComposerHistoryDraft(params: {
	activeAgentId: string | null | undefined;
	livePromptByAgent: Record<string, string>;
	renderedPrompt: string;
}): string {
	const { activeAgentId, livePromptByAgent, renderedPrompt } = params;
	if (!activeAgentId) return renderedPrompt;
	return livePromptByAgent[activeAgentId] ?? renderedPrompt;
}

/**
 * 判断光标是否在第一行/最后一行。
 * 历史导航只在单行边界触发，避免多行编辑时 ArrowUp/Down 抢走光标移动。
 */
export function getComposerHistoryLineBounds(
	text: string,
	cursorPos: number,
): { isFirstLine: boolean; isLastLine: boolean } {
	const safePos = Math.max(0, Math.min(cursorPos, text.length));
	const textBeforeCursor = text.substring(0, safePos);
	const textAfterCursor = text.substring(safePos);
	return {
		isFirstLine: !textBeforeCursor.includes("\n"),
		isLastLine: !textAfterCursor.includes("\n"),
	};
}

/**
 * 判断一组选项是否为纯是/否确认题。
 *
 * 业务背景：ask_question 的 confirm 在扩展层改走 select([是, 否])，
 * 以区分「点叉取消」与「选否」。桌面端若按普通 select 渲染，会误加自定义输入框。
 * 规则：恰好两项，且归一化后恰好覆盖 {yes,no}，不含其它文案。
 */
export function isYesNoConfirmOptions(
	options: Array<string | { label?: string; value?: string }> | undefined | null,
): boolean {
	if (!Array.isArray(options) || options.length !== 2) return false;
	const labels = options.map((opt) => {
		const raw =
			typeof opt === "string"
				? opt
				: String(opt?.label ?? opt?.value ?? "");
		return raw.trim().toLowerCase();
	});
	// 过滤自定义入口标记，防止异常数据混入后仍被当 confirm
	if (labels.some((l) => l.startsWith("✎") || l === "__other__")) return false;
	const yesSet = new Set(["是", "yes", "y", "true", "确认", "ok", "okay"]);
	const noSet = new Set(["否", "no", "n", "false", "取消"]);
	const kinds = labels.map((l) =>
		yesSet.has(l) ? "yes" : noSet.has(l) ? "no" : "other",
	);
	return kinds.includes("yes") && kinds.includes("no") && !kinds.includes("other");
}
