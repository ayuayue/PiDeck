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
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}

function extractTodoItems(message: string): TodoItem[] {
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return [];

	const items: TodoItem[] = [];
	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
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

	function updateWidget(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((item) => item.completed).length;
			ctx.ui.setWidget("pi-deck-plan-todos", [
				`Plan progress ${completed}/${todoItems.length}`,
				...todoItems.map((item) => `${item.completed ? "☑" : "☐"} ${item.step}. ${item.text}`),
			]);
			return;
		}
		ctx.ui.setWidget("pi-deck-plan-todos", undefined);
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
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function setPlanMode(ctx: ExtensionContext, enabled: boolean): void {
		planModeEnabled = enabled;
		executionMode = false;
		todoItems = [];
		if (enabled) {
			enablePlanModeTools();
			ctx.ui.notify("PiDeck Plan Mode enabled. Write tools are disabled until you execute a plan.", "info");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("PiDeck Plan Mode disabled. Normal tools restored.", "info");
		}
		updateWidget(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle PiDeck plan mode (read-only exploration)",
		handler: async (args, ctx) => {
			const normalized = String(args ?? "").trim().toLowerCase();
			if (["on", "enable", "enabled"].includes(normalized)) setPlanMode(ctx, true);
			else if (["off", "disable", "disabled", "normal"].includes(normalized)) setPlanMode(ctx, false);
			else setPlanMode(ctx, !planModeEnabled);
		},
	});

	pi.registerCommand("todos", {
		description: "Show current PiDeck plan progress",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No active PiDeck plan todos.", "info");
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
			// 用户发了一条普通消息（无 plan 标记）：若仍处于 plan 模式且非执行中，
			// 视为退出 plan——composer 切回 normal 发消息即退出只读模式。
			// pi-desktop RPC 模式下 /plan 命令不路由，这里作为会话内退出的兜底。
			if (planModeEnabled && !executionMode) {
				setPlanMode(ctx, false);
			}
			return;
		}

		// 由桌面输入框模式触发：隐藏标记只用于路由，必须在进入 LLM 前剥离。
		planModeEnabled = true;
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

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "pi-deck-plan-mode-context",
					content: `[PLAN MODE ACTIVE]\nYou are in PiDeck Plan Mode.\n\nRules:\n- Only inspect and reason. Do not edit or write files.\n- Bash is restricted to read-only commands.\n- Ask the user with ask_question when a requirement is ambiguous.\n- End your response with a numbered plan under an exact \"Plan:\" heading.\n\nPlan:\n1. First concrete step\n2. Second concrete step`,
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
		persistState();

		const todoListText = todoItems.map((item) => `${item.step}. ☐ ${item.text}`).join("\n");
		const choice = await ctx.ui.select("PiDeck Plan Mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = true;
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
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("How should the plan be refined?", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "pi-deck-plan-mode")
			.pop() as { data?: PlanModeState } | undefined;
		if (planModeEntry?.data) {
			// plan 模式不跨会话恢复：新会话默认 normal，避免用户被锁在只读模式无法写入。
			// 仅 execution（正在执行已确认计划）和 todos 跨会话续接。
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}
		planModeEnabled = false;
		updateWidget(ctx);
	});
}
