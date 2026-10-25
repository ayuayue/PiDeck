/**
 * PiDeck Plan Mode Extension
 *
 * 为 PiDeck 桌面输入框提供“Plan”发送模式：用户可见消息保持原文，
 * renderer 会在 agentMessage 中加入隐藏标记，本扩展在 pi input 事件里识别后
 * 临时切换为只读工具集，并要求 agent 输出 `Plan:` 编号计划。
 *
 * 生成计划后，扩展通过 RPC Extension UI Protocol 弹出执行/停留/修改选择；
 * 选择执行时恢复写工具，并用 [DONE:n] 标记驱动进度 widget。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PI_DECK_PLAN_MODE_MARKER = "__PI_DECK_PLAN_MODE__";

// Plan 模式只保留只读能力和桌面提问工具；恢复时会合并用户原本启用的其它自定义工具。
const PLAN_MODE_TOOLS = ["read", "bash", "ask_question"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "ask_question"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

// 静态模式规则：pi 1.x 走系统提示 section，旧宿主仍作为 before_agent_start 消息注入。
const PLAN_MODE_CONTEXT_TEXT = `[PLAN MODE ACTIVE]\nYou are in PiDeck Plan Mode.\n\nRules:\n- Only inspect and reason. Do not edit or write files.\n- Bash is restricted to read-only commands.\n- Ask the user with ask_question when a requirement is ambiguous.\n- Keep plan steps concise: one short sentence per step; avoid long clauses, parentheticals, or run-on requirements.\n- Put each step on its own numbered line (\"1. ...\", \"2. ...\"). Never nest or merge steps — the UI renders and tracks them line by line.\n- End your response with a numbered plan under an exact \"Plan:\" heading.\n\nPlan:\n1. First concrete step\n2. Second concrete step`;

/**
 * pi 1.x 的 before_agent_start 事件带可变 systemPromptOptions.sections；旧宿主没有该字段。
 * 扩展必须自包含，所以这里与 security-gate/goal-mode 各自保留一份（不跨文件 import）。
 */
function readSystemPromptSections(event: { systemPromptOptions?: { sections?: Record<string, string> } }): Record<string, string> | undefined {
	const sections = event.systemPromptOptions?.sections;
	return sections && typeof sections === "object" ? sections : undefined;
}

interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

/**
 * plan 模式激活来源：
 * - "composer"：桌面输入框计划 chip 发出的带标记消息（agentMessage 前缀隐藏标记）。
 *   这种路径下 composer 切回普通后发出的下一条**无标记**消息是唯一的退出信号。
 * - "command"：用户直接输入 /plan 命令激活。此时没有隐藏标记可依赖——
 *   后续普通任务消息本身就是「只读分析」的请求，绝不能当作退出信号，
 *   否则 /plan 刚开启、下一条消息立刻被禁用（2026-12 用户反馈：plan 模式貌似没法使用）。
 *   命令流的退出路径：计划草案选单关闭 / 「开始执行」 / 显式 /plan off。
 */
type PlanModeActivationSource = "composer" | "command";

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*ps\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function isSafeCommand(command: string): boolean {
	return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) &&
		SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function cleanStepText(text: string): string {
	// 只做 Markdown 清理（去加粗/行内代码标记、折叠空白），不做长度截断：
	// 步骤文本会进入「计划草案已就绪」选单标题，桌面端卡片按 pre-wrap 完整换行展示；
	// 截断会让用户在卡片和悬停提示里都看不到完整步骤（2026-12 用户反馈）。
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return cleaned;
}

function extractTodoItems(message: string): TodoItem[] {
	// 兼容 Plan: / **Plan:** / 中文「计划：」；不要求标题后必须立刻换行。
	const headerMatch = message.match(/(?:\*{0,2}Plan:\*{0,2}|计划[:：])\s*/i);
	if (!headerMatch || headerMatch.index === undefined) return [];

	const items: TodoItem[] = [];
	const planSection = message.slice(headerMatch.index + headerMatch[0].length);
	// 支持 1. / 1) / 1、 / 1:；整行再 clean，避免加粗步骤被截断。
	const numberedPattern = /^\s*(\d+)[.)、:]\s+(.+)$/gm;
	for (const match of planSection.matchAll(numberedPattern)) {
		const cleaned = cleanStepText(match[2] ?? "");
		if (cleaned.length > 3 && !cleaned.startsWith("/")) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

function markCompletedSteps(text: string, items: TodoItem[]): number {
	let changed = 0;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		const item = items.find((candidate) => candidate.step === step);
		if (item && !item.completed) {
			item.completed = true;
			changed += 1;
		}
	}
	return changed;
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

export default function piDeckPlanModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;
	let activationSource: PlanModeActivationSource | undefined;

	function updateWidget(ctx: ExtensionContext): void {
		// 规划阶段生成 Plan 后就应显示；以前只在 executionMode 才 setWidget，
		// 导致用户选「继续只读/关闭弹框」时 Plan 分区永远空白。
		if (todoItems.length === 0) {
			ctx.ui.setWidget("pi-deck-plan-todos", undefined);
			return;
		}
		const completed = todoItems.filter((item) => item.completed).length;
		const title = executionMode
			? `计划进度 ${completed}/${todoItems.length}`
			: `计划草案 ${todoItems.length} 步`;
		ctx.ui.setWidget("pi-deck-plan-todos", [
			title,
			...todoItems.map((item) => `${item.completed ? "☑" : "☐"} ${item.step}. ${item.text}`),
		]);
	}

	function persistState(): void {
		pi.appendEntry("pi-deck-plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
		});
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		// 快照只在首次进入 plan 时记录（退出时用它找回写权限），plan 模式的工具面以**当前**
		// 注册表为准：重复进入 plan（/plan on 后发 composer 计划消息）时若用旧快照重算，
		// 快照之后注册的第三方工具会在进入 plan 的一刻被覆盖删除（与退出路径同一类 bug，issue #349）。
		const current = pi.getActiveTools();
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = current;
		pi.setActiveTools(getPlanModeTools(current));
	}

	function restoreNormalModeTools(): void {
		// 增量恢复：快照只负责找回 plan 前的工具面（含 edit/write 写权限），
		// plan 期间后注册的第三方工具（billion-context 压缩工具等异步注册）以当前注册表为准保留。
		// 旧实现用快照全量覆盖 setActiveTools，会把 plan 激活后才注册的工具整批删掉（issue #349）。
		const current = pi.getActiveTools();
		const snapshot = toolsBeforePlanMode ?? getNormalModeTools(current);
		const keepThirdParty = current.filter((name) => !PLAN_MANAGED_TOOLS.has(name));
		pi.setActiveTools(uniqueToolNames([...snapshot, ...keepThirdParty]));
		toolsBeforePlanMode = undefined;
	}

	function setPlanMode(ctx: ExtensionContext, enabled: boolean, source?: PlanModeActivationSource): void {
		planModeEnabled = enabled;
		executionMode = false;
		todoItems = [];
		// 激活来源只在开启时登记，关闭时清掉：残留来源会让后续开启误用上一次的退出语义。
		activationSource = enabled ? source : undefined;
		if (enabled) {
			enablePlanModeTools();
			ctx.ui.notify("PiDeck 计划模式已启用。启用期间只能执行只读命令，不能修改文件。", "info");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("PiDeck 计划模式已禁用。已恢复写权限。", "info");
		}
		updateWidget(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "切换 PiDeck 计划模式（只读探索，适用于复杂任务先做分析）",
		handler: async (args, ctx) => {
			const normalized = String(args ?? "").trim().toLowerCase();
			if (["on", "enable", "enabled"].includes(normalized)) setPlanMode(ctx, true, "command");
			else if (["off", "disable", "disabled", "normal"].includes(normalized)) setPlanMode(ctx, false);
			else setPlanMode(ctx, !planModeEnabled, "command");
		},
	});

	pi.registerCommand("todos", {
		description: "查看当前计划进度",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("没有活跃的计划事项。", "info");
				return;
			}
			ctx.ui.notify(
				todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n"),
				"info",
			);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith(PI_DECK_PLAN_MODE_MARKER)) {
			// 无标记普通消息只在「composer 计划 chip」激活时才是退出信号：
			// 用户把输入框切回普通模式再发消息，说明要离开只读计划模式。
			// /plan 命令激活（source=command）时不能这么退出——普通任务消息本身就是
			// 分析请求，退出会立刻关掉刚开启的只读模式并让任务带写权限执行
			// （2026-12 用户反馈：/plan 后下一条消息直接提示已禁用）。
			if (planModeEnabled && !executionMode && activationSource === "composer") {
				setPlanMode(ctx, false);
			}
			return;
		}

		// 由桌面输入框模式触发：隐藏标记只用于路由，必须在进入 LLM 前剥离。
		planModeEnabled = true;
		activationSource = "composer";
		executionMode = false;
		todoItems = [];
		enablePlanModeTools();
		updateWidget(ctx);
		persistState();
		return {
			action: "transform" as const,
			text: event.text.slice(PI_DECK_PLAN_MODE_MARKER.length).replace(/^\s+/, ""),
		};
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const command = String(event.input.command ?? "");
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `PiDeck Plan Mode blocked a non-read-only command. Choose Execute after plan confirmation to allow writes.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;
		return {
			messages: event.messages.filter((message) => {
				const typed = message as AgentMessage & { customType?: string };
				// Plan/execution prompts are transient mode instructions; when the mode ends, keep them out of future context.
				return ![
					"pi-deck-plan-mode-context",
					"pi-deck-plan-execution-context",
				].includes(String(typed.customType ?? ""));
			}),
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (planModeEnabled) {
			// 静态规则进系统提示 section 而不是每轮 message：后者会把同一段文字在会话历史里
			// 复制一份又一份（实测单会话 22 条），既占 token 又污染历史（issue #365-09）。
			// 旧宿主无 sections 时保留原路径。
			const sections = readSystemPromptSections(event);
			if (sections) {
				sections["pi_deck_plan_mode"] = PLAN_MODE_CONTEXT_TEXT;
				return undefined;
			}
			return {
				message: {
					customType: "pi-deck-plan-mode-context",
					content: PLAN_MODE_CONTEXT_TEXT,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((item) => !item.completed);
			return {
				message: {
					customType: "pi-deck-plan-execution-context",
					content: `[EXECUTING PI_DECK PLAN]\nExecute remaining steps in order. After completing a step, include [DONE:n] in your response.\n\n${remaining.map((item) => `${item.step}. ${item.text}`).join("\n")}`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) {
			updateWidget(ctx);
			persistState();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((item) => item.completed)) {
				pi.sendMessage(
					{
						customType: "pi-deck-plan-complete",
						content: `**PiDeck Plan Complete** ✓\n\n${todoItems.map((item) => `- ${item.text}`).join("\n")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateWidget(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) todoItems = extractTodoItems(getTextContent(lastAssistant));
		if (todoItems.length === 0) return;
		// 先推 Plan 分区，再弹后续选择；用户无论选执行/继续/关闭都能在输入框上方看到草案。
		updateWidget(ctx);
		persistState();

		// 步骤前缀不用 ☐：该字形在部分 Windows 字体下渲染成空心方框（用户看到「1口」似乱码）。
		// 未完成/已完成语义由已完成进度（widget/plan-todos）表达，选单内无需占位标记。
		// 每步之间空一行（\n\n）：卡片/消息里步骤段落视觉分离，避免连续行挤在一起难读。
		const todoListText = todoItems.map((item) => `${item.step}. ${item.text}`).join("\n\n");
		// 循环展示选单：仅在选项处理未定夺时重试；关闭选单（X/Esc）走 else 分支退出 plan 模式。
		// 标题前缀 [PI_DECK_PLAN_NEXT] 给桌面端识别：关闭=退出计划模式，不是「默认第一项」。
		// 标题前缀 [PI_DECK_PLAN_NEXT]：桌面端识别后换专用 UI/取消提示。
		// 选项用「标题|说明」编码，桌面端拆成主副文案；前缀仍用于 startsWith 匹配。
		// 摘要区两行：首行是「N 步 + 是否执行」提问，次行引导去上方待办条看详细步骤；
		// 步骤已写入 pi-deck-plan-todos widget，卡片默认不重复铺满（桌面端 line-clamp 两行预览，
		// 眼睛按钮/悬停展开步骤全文）。
		const PLAN_NEXT_TITLE =
			"[PI_DECK_PLAN_NEXT] 计划草案已就绪（" +
			todoItems.length +
			" 步），是否执行？\n具体计划可点击下方待办查看详细列表\n\n" +
			todoListText;
		const PLAN_OPT_EXECUTE = "开始执行|恢复写权限，按步骤改代码并勾进度";
		// 「先不执行」只结束本轮、保持只读；不会自动再分析，需用户再发消息。
		const PLAN_OPT_CONTINUE = "先不执行|结束本轮，保持只读；再发消息后 AI 才继续";
		// 只保留两个动作（2026-12 用户反馈：三枚按钮两行摆放对不齐）；
		// 修改意见走「先不执行」后直接发消息，不再单独提供「修改计划」入口。
		let actionTaken = false;
		while (!actionTaken) {
			const choice = await ctx.ui.select(PLAN_NEXT_TITLE, [
				PLAN_OPT_EXECUTE,
				PLAN_OPT_CONTINUE,
			]);

			if (choice?.startsWith("开始执行")) {
				planModeEnabled = false;
				executionMode = true;
				activationSource = undefined;
				restoreNormalModeTools();
				updateWidget(ctx);
				persistState();
				pi.sendMessage(
					{ customType: "pi-deck-plan-todos", content: `**Plan Steps (${todoItems.length})**\n\n${todoListText}`, display: true },
					{ deliverAs: "followUp" },
				);
				pi.sendMessage(
					{
						customType: "pi-deck-plan-execute",
						content: `Execute the approved plan.\n\n${todoItems.map((item) => `${item.step}. ${item.text}`).join("\n")}\n\nAfter completing a step, include [DONE:n].`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				actionTaken = true;
			} else if (choice?.startsWith("先不执行") || choice?.startsWith("继续规划")) {
				// 结束本轮、保持 plan 只读；不 triggerTurn，用户再发消息才会继续
				actionTaken = true;
			} else {
				// 关闭选单（X / Esc）→ 退出 plan 模式；不会默认选「开始执行」
				setPlanMode(ctx, false);
				actionTaken = true;
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "pi-deck-plan-mode")
			.pop() as { data?: PlanModeState } | undefined;
		let droppedStaleTodos = false;
		if (planModeEntry?.data) {
			// plan 模式不跨会话恢复：新会话默认 normal，避免用户被锁在只读模式无法写入。
			// 待办只在执行态下续接：非执行态（计划草案）恢复回来的待办永远不会被
			// [DONE:n] 标记（turn_end 靠 executionMode 拦截），只会永久挂成「N 待处理」，
			// 且面板 X 只是渲染层隐藏、重开会话又会从会话文件里读回来（issue #393）。
			const wasExecuting = planModeEntry.data.executing === true;
			const restoredTodos = planModeEntry.data.todos ?? [];
			droppedStaleTodos = !wasExecuting && restoredTodos.length > 0;
			todoItems = wasExecuting ? restoredTodos : [];
			executionMode = wasExecuting;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}
		planModeEnabled = false;
		// 激活来源是运行时状态，不随会话恢复（plan 模式本身不跨会话），重置避免残留。
		activationSource = undefined;
		updateWidget(ctx);
		// 丢弃草案时同步写回：否则会话文件里的旧 todos 会一直被后来的恢复读到，
		// 每次重开都要再过滤一遍（#393 里「关标签再打开又回来」的直接来源）。
		if (droppedStaleTodos) persistState();
	});
}
