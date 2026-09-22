export type SendShortcut = "enter-send" | "ctrl-enter-send" | "shift-enter-send";

export type ComposerEnterIntent = "ignore" | "newline" | "send";

import type { AgentBackend, ComposerAgentMode } from "@shared/types";
import { formatPromptTemplateBlock } from "./components/session/composer/referenceBlocks";

export const PI_DECK_PLAN_MODE_MARKER = "__PI_DECK_PLAN_MODE__";
export const PI_DECK_GOAL_MODE_MARKER = "__PI_DECK_GOAL_MODE__";

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
/**
 * 把 /命令（技能/Prompt 模板）追加到草稿尾部：
 * - draft 非空：去掉尾随空白后补一个空格再接 `/${command} `，避免命令 token 与
 *   已有内容粘连成一体（与文件引用需要空格的语义一致，用户才看得出是独立引用）。
 * - draft 为空：直接以 `/${command} ` 开头（后续回车即可发送）。
 */
export function appendSlashCommandToDraft(draft: string, command: string): string {
	const token = `/${command} `;
	return draft.trimEnd() ? `${draft.trimEnd()} ${token}` : token;
}

/**
 * 技能调用的斜杠 token（纯函数，供技能选择器与 controller 共用，单一来源）。
 * pi 的技能是内建 `/skill:名称` 命令（pi settings 的 enableSkillCommands 开关）：
 * 裸写 `/名称` pi 会当未知命令拒绝——这正是「斜线命令把技能过滤掉」的根因；
 * DSH 宿主由 dsh-tool-skill 把裸 `/名称` 注册成技能命令，保持原样即可。
 * 返回不含斜杠的命令名，由 appendSlashCommandToDraft 统一拼 `/<token> `。
 */
export function toSkillInvocationToken(backend: AgentBackend, name: string): string {
	// imagegen 无 LLM 不发技能，这里仅兜底按 pi 形态（不会实际被调用）；仅 dsh 用裸名
	return backend === "dsh" ? name : `skill:${name}`;
}

/**
 * 剥离 Markdown 文件的 YAML frontmatter「描述头」：`---` 元数据是给选择器列表/
 * 模型目录用的，一键插入全文时应只插正文（否则输入框里会看到 name/description 头）。
 * 无 frontmatter 的纯正文原样返回；frontmatter 后的首个空行不保留。
 */
export function stripMarkdownFrontmatter(content: string): string {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
	if (!match) return content;
	return content.slice(match[0].length).replace(/^\r?\n/, "");
}

/**
 * 把完整正文（提示词模板内容 / 技能 SKILL.md 指令）追加到草稿尾部：
 * 正文是多行文本，不能像斜杠命令那样用空格拼接——draft 非空时换行衔接，
 * 避免命令 token 与已有草稿内容粘连；空草稿直接以正文开头。
 */
export function appendContentToDraft(draft: string, content: string): string {
	if (!content) return draft;
	return draft.trimEnd() ? `${draft.trimEnd()}\n${content}` : content;
}

export function parseArgumentHint(content: string): string | undefined {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return undefined;
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		if (key === "argument-hint") {
			return line
				.slice(idx + 1)
				.trim()
				.replace(/^['"]|['"]$/g, "");
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
	"commit-own": "只提交自己修改的文件和代码（跳过无关改动）",
	"commit-split": "提交所有改动，按功能拆分为多个 commit",
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
	"commit-own": "Commit only the files you modified yourself (skip unrelated changes)",
	"commit-split": "Commit all changes split into multiple commits grouped by feature",
	"pi-system": "View pi's default system prompt (identity, tools, guidelines)",
	"skill-discipline": "Skills execution discipline: rules for when and how to trigger agent skills",
};

/**
 * 翻译内置 prompt 模板的 description（UI 展示用）。
 * 非内置模板保持原样。
 */
export function translateBuiltinPromptDescription(template: PromptTemplateInfo): string {
	if (!template.path.startsWith("builtin://")) return template.description;
	// 根据 html[data-theme] 判断语言环境——中文用 CN 映射，其余用 EN
	const isChinese = typeof document !== "undefined" && document.documentElement.lang?.startsWith("zh");
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
 * - 模板正文为空（UI 新建模板只写 frontmatter、正文待编辑）时不展开：
 *   保持 /name 原样并返回 emptyTemplateName，调用方据此给出明确提示，
 *   避免展开成空白导致主进程“消息不能为空”的误导性拒绝
 * - 展开时剥离 content 中的 frontmatter，避免元数据泄漏到对话消息中
 * - 展开结果写成自包含 `<prompt_template>` 块：模型仍读完整模板正文，气泡可在重启、
 *   模板改名或删除后稳定还原为 `/模板名` chip（不依赖当前模板列表）
 */
export function expandPromptTemplates(message: string, templates: PromptTemplateInfo[]): { message: string; description?: string; emptyTemplateName?: string } {
	if (!templates.length || !message.includes("/")) return { message };

	// 按 name 长度降序排序，确保正则交替时最长匹配优先
	const sorted = [...templates].sort((a, b) => b.name.length - a.name.length);
	const nameToContent = new Map(sorted.map((t) => [t.name, t.content]));
	const nameToDescription = new Map(sorted.map((t) => [t.name, t.description]));

	// 记录最后匹配到的模板名，用于提取 description 作为元数据发送给 pi agent
	let matchedName: string | undefined;
	// 记录展开时发现正文为空的模板名（可能多个，取最后一个即可用于提示）
	let emptyTemplateName: string | undefined;

	// 构建 /name1|/name2|/name3 的单一正则，捕获命令前后的空白分隔符
	const escapedNames = sorted.map((t) => t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const regex = new RegExp(`(^|\\s)/(${escapedNames.join("|")})(\\s|$)`, "g");

	const expanded = message.replace(regex, (_match, prefix, name, suffix) => {
		matchedName = name;
		const rawContent = nameToContent.get(name) ?? "/" + name;
		// 剥离 content 中的 frontmatter 元数据，只保留正文，
		// 避免 `---\ndescription: xxx\n---` 泄漏到 pi agent 的对话消息中。
		const content = stripFrontmatter(rawContent);
		// 正文为空时（如 UI 新建模板只有 frontmatter）不展开，保留 /name 原文：
		// 直接展开会产出空白/仅分隔符消息，被主进程拒为“消息不能为空”。
		if (!content.trim()) {
			emptyTemplateName = name;
			return _match;
		}
		// 命令后有用户输入时用两个换行分隔模板内容和用户输入，提升可读性。
		// 内容和模板名一起编码：前端展示只折叠为 /name，但模型仍可读取完整正文。
		const separator = suffix && /\s/.test(suffix) ? "\n\n" : "";
		return prefix + formatPromptTemplateBlock(name, content) + separator;
	});

	return {
		message: expanded,
		description: matchedName ? nameToDescription.get(matchedName) : undefined,
		emptyTemplateName,
	};
}

/** DSH 当前目标投影（只取派生模式/首轮 /goal 需要的字段）。 */
export type DshGoalModeSnapshot = {
	phase?: "active" | "paused" | "blocked" | "complete";
};

/**
 * 桌面端派生 composer 模式。DSH：plan 由 host 持有；goal 由本地选择或进行中/阻塞的目标驱动。
 * 切回普通会把本地 mode 写成 normal，因此 paused 目标不会把选择器锁在目标模式。
 */
export function deriveComposerAgentMode(input: { backend?: AgentBackend; localMode?: ComposerAgentMode; planModeActive?: boolean; goalPhase?: DshGoalModeSnapshot["phase"] }): ComposerAgentMode {
	const localMode = input.localMode;
	// imagegen 是独立后端：会话为生图后端时恒为生图模式（无 LLM mode 概念）
	if (input.backend === "imagegen") return "imagegen";
	// 遗留兼容：legacy 生图消息在 pi 会话上，localMode 仍可能是 imagegen，保留
	if (localMode === "imagegen") return "imagegen";
	if (input.backend !== "dsh") return localMode ?? "normal";
	if (input.planModeActive) return "plan";
	// 用户刚切回普通时 localMode 为 "normal"：即使 pause IPC 尚未落地，也不要把选择器弹回目标。
	if (localMode === "normal") return "normal";
	if (localMode === "goal") return "goal";
	// 刷新后 atom 为空：进行中/阻塞的目标把选择器恢复为 goal。
	if (input.goalPhase === "active" || input.goalPhase === "blocked") return "goal";
	return "normal";
}

/**
 * DSH 没有 pi 的隐藏 agentMessage。首次进入目标且还没有 goal 时，把用户原文改写成 host `/goal`。
 * 已有未完成目标时保持原文，由 resume IPC + 普通 prompt 推进。
 */
export function applyDshGoalSendTransform(input: { message: string; mode: ComposerAgentMode; goal?: DshGoalModeSnapshot }): string {
	if (input.mode !== "goal") return input.message;
	const trimmed = input.message.trim();
	if (!trimmed || trimmed.startsWith("/")) return input.message;
	const phase = input.goal?.phase;
	if (phase && phase !== "complete") return input.message;
	return `/goal ${trimmed}`;
}

/** 解析 pi-deck-goal-mode widget 行：`phase · rounds/max` + 目标 + 可选阻塞原因。 */
export function parsePiGoalWidget(lines: readonly string[] | undefined):
	| {
			phase: "active" | "paused" | "blocked" | "complete";
			objective: string;
			roundsStarted: number;
			maxGoalRounds: number;
			blockReason?: string;
	  }
	| undefined {
	if (!lines || lines.length < 2) return undefined;
	const header = lines[0]?.trim() ?? "";
	const match = header.match(/^(active|paused|blocked|complete)\s*·\s*(\d+)\s*\/\s*(\d+)\s*$/);
	if (!match) return undefined;
	const objective = lines[1]?.trim() ?? "";
	if (!objective) return undefined;
	const phaseToken = match[1];
	if (phaseToken !== "active" && phaseToken !== "paused" && phaseToken !== "blocked" && phaseToken !== "complete") {
		return undefined;
	}
	return {
		phase: phaseToken,
		objective,
		roundsStarted: Number(match[2]),
		maxGoalRounds: Number(match[3]),
		...(phaseToken === "blocked" && lines[2]?.trim() ? { blockReason: lines[2].trim() } : {}),
	};
}

export function buildComposerPromptSubmission(message: string, mode: ComposerAgentMode): ComposerPromptSubmission {
	const trimmed = message.trim();
	// 斜线命令原样发送，让 pi 解析执行——plan/goal 模式下也能用 /plan off、/goal pause。
	// 否则隐藏标记前缀会把命令变成普通消息发给 LLM。
	if (trimmed.startsWith("/")) return { message };

	if (mode === "plan") {
		const visibleInstruction = trimmed || "请根据已附加的图片或上下文先制定实施计划。";
		return {
			message,
			agentMessage: [PI_DECK_PLAN_MODE_MARKER, visibleInstruction, "", "请先只做只读分析，不要修改文件。最后必须输出以 `Plan:` 开头的编号计划，格式如下：", "Plan:", "1. 第一步", "2. 第二步"].join("\n"),
		};
	}

	if (mode === "goal") {
		const visibleInstruction = trimmed || "请继续当前目标。";
		return {
			message,
			agentMessage: [PI_DECK_GOAL_MODE_MARKER, visibleInstruction].join("\n"),
		};
	}

	return { message };
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
export function getComposerEnterIntent(event: ComposerKeyboardState, sendShortcut: SendShortcut): ComposerEnterIntent {
	if (event.key !== "Enter") return "ignore";
	if (isComposingKeyboardEvent(event)) return "ignore";

	const shouldSend = sendShortcut === "enter-send" ? !event.ctrlKey && !event.metaKey && !event.shiftKey : sendShortcut === "ctrl-enter-send" ? event.ctrlKey || event.metaKey : event.shiftKey;

	if (shouldSend) return "send";
	return "newline";
}

/**
 * 判断 plan 模式下是否应当把按键视为「发送」意图。
 *
 * 业务规则：plan 是一次性提交流——用户点「计划模式」chip 后回车即发一眼计划，
 * 不再受「发送快捷键」sendShortcut 设置（enter/ctrl-enter/shift-enter）影响；
 * 否则用户把 sendShortcut 设为 ctrl/shift-enter 时，plan 模式回车只会被当成换行。
 * 依旧忽略 IME 合成中的回车（复用 isComposingKeyboardEvent），并剔除 Ctrl/Meta/Shift
 * 修饰键，保证 Shift+Enter 换行、Ctrl+Enter 快捷键等原有语义不被破坏。
 */
export function isPlanModeSendKey(event: ComposerKeyboardState): boolean {
	if (event.key !== "Enter") return false;
	if (isComposingKeyboardEvent(event)) return false;
	if (event.ctrlKey || event.metaKey || event.shiftKey) return false;
	return true;
}

/**
 * 判断一次按键是否处于 IME 合成中，是所有 composer 输入路径唯一的 IME 判定口。
 *
 * 必须同时看 `event` 与 `event.nativeEvent`：TipTap 的 DOM 事件桥接会把原生
 * KeyboardEvent 直接交给 React 风格的处理函数，此时没有 `nativeEvent`，
 * 只查 `nativeEvent.isComposing` 会漏判，导致中文输入法确认候选时被当成
 * 「发送」或「选中建议项」。
 */
export function isComposingKeyboardEvent(event: ComposerKeyboardState) {
	// Shift+Enter 不可能是 IME 合成，直接跳过检测
	if (event.shiftKey) return false;
	// keyCode/which=229 是部分 Chromium/macOS 输入法在 composition 期间的兼容信号。
	return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.key === "Process" || event.keyCode === 229 || event.which === 229 || event.nativeEvent?.keyCode === 229 || event.nativeEvent?.which === 229);
}

/**
 * 解析历史导航应该快照的 composer 草稿。
 *
 * 业务背景：普通键盘输入只更新 livePromptByAgentRef，不会触发 App 重渲染；
 * 因此 ArrowUp 闭包里的 renderedPrompt 可能停留在上次 chips/空状态翻转时。
 * 必须优先读 live ref，否则按上键再按下键时会丢掉中间继续输入的部分。
 */
export function resolveComposerHistoryDraft(params: { activeAgentId: string | null | undefined; livePromptByAgent: Record<string, string>; renderedPrompt: string }): string {
	const { activeAgentId, livePromptByAgent, renderedPrompt } = params;
	if (!activeAgentId) return renderedPrompt;
	return livePromptByAgent[activeAgentId] ?? renderedPrompt;
}

/** 历史导航按键的处置结果：三种接管方式 + 放行。 */
export type ComposerHistoryNavIntent = "recall-older" | "recall-newer" | "restore-draft" | "release";

export type ComposerHistoryKeyState = {
	/** KeyboardEvent.key。 */
	key: string;
	/** 光标所在顶层块就是文档第一个块（取自 ProseMirror state，不受软换行影响）。 */
	atFirstBlock: boolean;
	/** 光标所在顶层块就是文档最后一个块。 */
	atLastBlock: boolean;
	/** 光标上方没有视觉行（软换行后的首视觉行也算）。 */
	atVisualTop: boolean;
	/** 光标下方没有视觉行。 */
	atVisualBottom: boolean;
	/** -1 表示未在浏览历史。 */
	historyIndex: number;
	historyLength: number;
	/** Shift/Ctrl/Alt/Meta 任意组合。 */
	modifier: boolean;
	/** 非折叠选区（选中了文本）。 */
	hasSelection: boolean;
};

/**
 * 决定 ↑/↓/Esc 是否由 composer 接管，以及接管成什么动作。
 *
 * 业务规则（对齐 Claude Code 与同类产品的既定行为）：
 * - 边界是**视觉行**，不是逻辑行：输入框跨多个视觉行时，↑/↓ 先移动光标；
 *   光标已在首/末视觉行且确实无路可走时，才走历史。
 *   只判逻辑行会让软换行后的视觉第 2 行被当成首行，一按 ↑ 就把草稿换成历史消息。
 * - 两段判定必须相与：atVisual* 只看光标所在块内部的行盒（块内判定），
 *   atFirstBlock/atLastBlock 才能回答「是不是文档首/末块」——合起来才是
 *   「整个编辑器里光标上方/下方没有任何视觉行」。
 * - 方向键上的修饰键一律放行：Shift+↑ 是扩选，Ctrl/Alt/Meta+↑ 是词/段跳转，抢走会让用户没法选词与选择。
 * - 有选区时方向键一律放行：选中文本时的方向键属于选区调整，拿去回填会连选区一起丢掉。
 * - 无历史 / 未在浏览时的 ↓ 一律放行（纯光标移动）。
 * - Esc 不参与上述守卫：它在浏览态的唯一语义就是「放弃回填、还原草稿」，输入框里
 *   Shift/Alt+Esc 没有竞争语义，把它归入放行反而会让用户困在浏览态。
 *
 * IME 合成态不在这里判断：它必须在 keydown 入口统一拦截（那里还要覆盖候选菜单分支），
 * 调用方保证传进来的按键已经过 isComposingKeyboardEvent 过滤。
 */
export function resolveComposerHistoryIntent(state: ComposerHistoryKeyState): ComposerHistoryNavIntent {
	if (state.key === "Escape") return state.historyIndex >= 0 ? "restore-draft" : "release";

	if (state.modifier || state.hasSelection) return "release";

	if (state.key === "ArrowUp") {
		if (!state.atFirstBlock || !state.atVisualTop) return "release";
		return state.historyLength > 0 ? "recall-older" : "release";
	}

	if (state.key === "ArrowDown") {
		// 未在浏览时 ↓ 永远只是光标下移，不回填。
		if (state.historyIndex < 0) return "release";
		if (!state.atLastBlock || !state.atVisualBottom) return "release";
		return "recall-newer";
	}

	return "release";
}

/**
 * 判断一组选项是否为纯是/否确认题。
 *
 * 业务背景：ask_question 的 confirm 在扩展层改走 select([是, 否])，
 * 以区分「点叉取消」与「选否」。桌面端若按普通 select 渲染，会误加自定义输入框。
 * 规则：恰好两项，且归一化后恰好覆盖 {yes,no}，不含其它文案。
 */
export function isYesNoConfirmOptions(options: Array<string | { label?: string; value?: string }> | undefined | null): boolean {
	if (!Array.isArray(options) || options.length !== 2) return false;
	const labels = options.map((opt) => {
		const raw = typeof opt === "string" ? opt : String(opt?.label ?? opt?.value ?? "");
		return raw.trim().toLowerCase();
	});
	// 过滤自定义入口标记，防止异常数据混入后仍被当 confirm
	if (labels.some((l) => l.startsWith("✎") || l === "__other__")) return false;
	const yesSet = new Set(["是", "yes", "y", "true", "确认", "ok", "okay"]);
	const noSet = new Set(["否", "no", "n", "false", "取消"]);
	const kinds = labels.map((l) => (yesSet.has(l) ? "yes" : noSet.has(l) ? "no" : "other"));
	return kinds.includes("yes") && kinds.includes("no") && !kinds.includes("other");
}

/**
 * 从会话消息里提取可导航的用户输入历史（最新在前）。
 *
 * 业务背景：未启动的 Agent（纯历史会话）没有本次运行发送记录，上下键历史为空；
 * 旧版在激活后读取全部消息填充，重构版改为从会话消息缓存（disk/runtime 同源）提取，
 * 激活前后行为一致。
 * 规则：只取 user 角色且有实质文本的消息；跳过空文本与 "!" 开头命令（与
 * recordPromptHistory 的过滤一致）；截断到 limit 条（默认 50，与发送历史一致）。
 */
export function extractUserPrompts(messages: ReadonlyArray<{ role: string; text: string }>, limit = 50): string[] {
	const prompts: string[] = [];
	// 消息按时间正序，从后往前取保证最新在前
	for (let i = messages.length - 1; i >= 0 && prompts.length < limit; i--) {
		const text = messages[i].text.trim();
		if (messages[i].role !== "user" || !text || text.startsWith("!")) continue;
		prompts.push(text);
	}
	return prompts;
}

/**
 * 合并「本次运行发送的」与「会话历史已有的」用户输入，供上下键历史导航。
 *
 * 规则：
 * - runtimePrompts 最新在前（recordPromptHistory 的存储顺序）；
 *   sessionPrompts 按时间正序传入，内部反转成最新在前；
 * - 全局去重：runtime 优先保留，session 中与已出现条目重复的跳过
 *   （激活前后重复发送同一条时不出现两条）；
 * - 截断到 limit 条（默认 50，与 recordPromptHistory 一致）。
 */
export function mergePromptHistory(runtimePrompts: readonly string[], sessionPrompts: readonly string[], limit = 50): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const prompt of [...runtimePrompts, ...[...sessionPrompts].reverse()]) {
		if (seen.has(prompt)) continue;
		seen.add(prompt);
		merged.push(prompt);
		if (merged.length >= limit) break;
	}
	return merged;
}
