/**
 * PiDeck Goal Mode Extension
 *
 * 为 composer「目标模式」提供 pi 侧实现（DSH 走 host ctx.goals，不走本扩展）：
 * - renderer 在 agentMessage 里加入隐藏标记，input 钩子识别后进入目标态；
 * - 围绕一条 objective 自动续轮（agent_end → followUp），直到完成 / 暂停 / 阻塞 / 轮次上限；
 * - 切回普通模式发出的下一条无标记消息会暂停目标（不清除，可再切回恢复）。
 *
 * 完成约定：模型在回复中写 `GOAL_COMPLETE` 或 `GOAL_BLOCKED: 原因`。
 * 不要发明第二条通信通道；状态用 pi.appendEntry 写入会话，跨重启可恢复为 paused。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PI_DECK_GOAL_MODE_MARKER = "__PI_DECK_GOAL_MODE__";
const GOAL_WIDGET_KEY = "pi-deck-goal";
const GOAL_ENTRY_TYPE = "pi-deck-goal-mode";
const GOAL_CONTEXT_TYPE = "pi-deck-goal-context";
const DEFAULT_MAX_ROUNDS = 32;

// 静态规则：pi 1.x 走系统提示 section，旧宿主仍随 before_agent_start 消息注入。
const GOAL_MODE_RULES = [
	"Rules:",
	"- Work toward the objective. Prefer concrete tool use over asking the user.",
	"- If the objective is fully achieved, end with the exact token GOAL_COMPLETE.",
	"- If you are blocked (missing info, failed approach, or need a user decision), end with GOAL_BLOCKED: <short reason>.",
	"- Do not wait for extra confirmation once the next step is clear.",
].join("\n");

/**
 * pi 1.x 的 before_agent_start 事件带可变 systemPromptOptions.sections；旧宿主没有该字段。
 * 扩展必须自包含，所以这里与 security-gate/plan-mode 各自保留一份（不跨文件 import）。
 */
function readSystemPromptSections(event: { systemPromptOptions?: { sections?: Record<string, string> } }): Record<string, string> | undefined {
	const sections = event.systemPromptOptions?.sections;
	return sections && typeof sections === "object" ? sections : undefined;
}

type GoalPhase = "active" | "paused" | "blocked" | "complete";

interface GoalModeState {
	enabled: boolean;
	phase: GoalPhase;
	objective: string;
	roundsStarted: number;
	maxGoalRounds: number;
	blockReason?: string;
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

function detectTerminal(text: string): { phase: "complete" } | { phase: "blocked"; reason: string } | undefined {
	if (/\bGOAL_COMPLETE\b/.test(text)) return { phase: "complete" };
	const blocked = text.match(/\bGOAL_BLOCKED\s*:\s*(.+)/);
	if (blocked) return { phase: "blocked", reason: blocked[1]?.trim() || "blocked" };
	return undefined;
}

export default function piDeckGoalModeExtension(pi: ExtensionAPI): void {
	let state: GoalModeState = {
		enabled: false,
		phase: "paused",
		objective: "",
		roundsStarted: 0,
		maxGoalRounds: DEFAULT_MAX_ROUNDS,
	};

	/** 宿主是否提供系统提示 section（pi 1.x）；决定续轮指令还要不要带目标全文。 */
	let sectionsAvailable = false;
	/** 上一次落盘的目标全文：目标在 run 内不变，每轮只追加轮次（issue #366）。 */
	let persistedObjective = "";

	function persistState(force = false): void {
		// 32 轮上限，若每轮都写完整 state，历史里会堆 32 份目标原文（本机实测每条约 2000 字）。
		// 目标只在变化时落盘，其余轮次省略 objective 字段；session_start 回溯最近一条带目标的记录。
		// force：清除目标时必须落 objective:""，否则回溯会穿透到旧目标、重启后复活（issue #395）。
		const objectiveChanged = force || state.objective !== persistedObjective;
		persistedObjective = state.objective;
		const entry: Partial<GoalModeState> = { ...state };
		if (!objectiveChanged) delete entry.objective;
		pi.appendEntry(GOAL_ENTRY_TYPE, entry);
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (!state.enabled || !state.objective || state.phase === "complete") {
			ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
			return;
		}
		// 第一行稳定可解析（phase · rounds/max），第二行是目标原文；桌面 GoalStrip 靠这个形状。
		ctx.ui.setWidget(GOAL_WIDGET_KEY, [
			`${state.phase} · ${state.roundsStarted}/${state.maxGoalRounds}`,
			state.objective,
			...(state.phase === "blocked" && state.blockReason ? [state.blockReason] : []),
		]);
	}

	function setPaused(ctx: ExtensionContext, notify: boolean): void {
		if (!state.enabled) return;
		state = { ...state, enabled: true, phase: "paused" };
		updateWidget(ctx);
		persistState();
		if (notify) ctx.ui.notify("PiDeck 目标模式已暂停。切回目标模式后会从当前进度继续。", "info");
	}

	function setActive(ctx: ExtensionContext, objective?: string): void {
		const nextObjective = (objective ?? state.objective).trim();
		if (!nextObjective) {
			ctx.ui.notify("目标模式需要一条要达成的目标。", "warning");
			return;
		}
		// 显式传入新目标 = 替换语义：轮次从 0 重新记账。否则上一目标消耗的轮次
		// 会顶到新目标头上，刚替换的目标直接显示 "active · 5/32" 且提前撞上限。
		// 恢复（setActive() 不传参）保留原轮次，符合「暂停后从当前进度继续」。
		const replacing = typeof objective === "string";
		state = {
			...state,
			enabled: true,
			phase: "active",
			objective: nextObjective,
			blockReason: undefined,
			roundsStarted: replacing ? 0 : state.roundsStarted,
			maxGoalRounds: state.maxGoalRounds || DEFAULT_MAX_ROUNDS,
		};
		updateWidget(ctx);
		persistState();
	}

	function setComplete(ctx: ExtensionContext): void {
		state = { ...state, enabled: false, phase: "complete" };
		updateWidget(ctx);
		persistState();
		ctx.ui.notify("PiDeck 目标已完成。", "info");
	}

	function setBlocked(ctx: ExtensionContext, reason: string): void {
		state = { ...state, enabled: true, phase: "blocked", blockReason: reason };
		updateWidget(ctx);
		persistState();
		ctx.ui.notify(`PiDeck 目标已阻塞：${reason}`, "warning");
	}

	/**
	 * 派发一轮目标续跑：agent_end 自动续轮与 /goal resume 手动恢复共用。
	 * deliverAs "followUp"（流式中排队）/ triggerTurn（空闲时直接起一轮）
	 * 让「恢复」真正驱动一轮模型，而不是只把 phase 标回 active 后空转。
	 */
	function kickOffContinuation(): void {
		// 目标全文已经在系统提示 section 里（issue #366）：续轮指令不再重复一遍，
		// 否则每轮都会把 2000 字目标写进会话历史。旧宿主没有 section，仍然随消息带上。
		const objectiveLine = sectionsAvailable ? "" : `Objective: ${state.objective}\n`;
		pi.sendMessage(
			{
				customType: "pi-deck-goal-continue",
				content: `Continue the current goal.\n${objectiveLine}Rounds used: ${state.roundsStarted}/${state.maxGoalRounds}\nIf done, write GOAL_COMPLETE. If blocked, write GOAL_BLOCKED: <reason>.`,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	pi.registerCommand("goal", {
		description: "切换 PiDeck 目标模式（围绕一个目标自动连续推进）",
		handler: async (args, ctx) => {
			const raw = String(args ?? "").trim();
			const normalized = raw.toLowerCase();
			if (["pause", "off", "disable"].includes(normalized)) {
				setPaused(ctx, true);
				return;
			}
			if (["clear", "reset"].includes(normalized)) {
				state = {
					enabled: false,
					phase: "paused",
					objective: "",
					roundsStarted: 0,
					maxGoalRounds: DEFAULT_MAX_ROUNDS,
				};
				updateWidget(ctx);
				// 清空的 objective 也必须落盘：否则「目标没变」判据会让这条记录省略 objective，
				// 会话里读不出「已清除」，重启回溯时穿透到更早的目标（issue #395）。
				persistState(true);
				ctx.ui.notify("PiDeck 目标已清除。", "info");
				return;
			}
			if (["resume", "on", "enable"].includes(normalized)) {
				if (!state.objective) {
					ctx.ui.notify("没有可恢复的目标，请先输入目标。", "warning");
					return;
				}
				setActive(ctx);
				// 恢复必须真正触发一轮续跑：否则 agent 空闲时 goal 只标 active、不干活。
				kickOffContinuation();
				return;
			}
			if (raw) {
				state = { ...state, roundsStarted: 0 };
				setActive(ctx, raw);
				return;
			}
			if (!state.objective) {
				ctx.ui.notify("当前没有目标。发送一条目标，或使用 /goal <目标>。", "info");
				return;
			}
			ctx.ui.notify(
				`目标（${state.phase}） ${state.roundsStarted}/${state.maxGoalRounds}\n${state.objective}`,
				"info",
			);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith(PI_DECK_GOAL_MODE_MARKER)) {
			// composer 切回普通后发出的下一条无标记消息：暂停而不是清除。
			if (state.enabled && state.phase === "active") {
				setPaused(ctx, true);
			}
			return;
		}

		const body = event.text.slice(PI_DECK_GOAL_MODE_MARKER.length).replace(/^\s+/, "");
		if (!state.objective) {
			setActive(ctx, body);
		} else if (state.phase === "complete") {
			// 上一目标已完成：目标模式里发的原文是「替换为新目标」，不是续跑旧目标。
			// 修复前这里落入末位 else 只把 phase 掰回 active，objective 仍是旧目标——
			// 新目标既不显示也不执行（2026-08 反馈：目标完成后新目标不更新）。
			setActive(ctx, body);
		} else if (state.phase === "paused" || state.phase === "blocked") {
			// 暂停/阻塞 ≠ 完成：正文保持原文推进同一目标（resume 后由正文驱动继续）。
			setActive(ctx);
		} else {
			// 进行中新目标原文 = 推进当前目标（轮次不清零）。
			state = { ...state, enabled: true, phase: "active" };
			updateWidget(ctx);
			persistState();
		}
		return {
			action: "transform" as const,
			text: body,
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.enabled || state.phase !== "active" || !state.objective) return;
		const roundLine = `[GOAL MODE ACTIVE] Round: ${state.roundsStarted + 1}/${state.maxGoalRounds}`;
		// 静态规则 + 目标全文进系统提示 section：目标在一次 run 内不变，section 字节稳定，
		// 前缀缓存不失效；每轮真正变化的只有 Round，消息里只留这一行（issue #365-10 / #366）。
		// 旧宿主无 sections 时保留整块旧文案。
		const sections = readSystemPromptSections(event);
		if (sections) {
			sectionsAvailable = true;
			sections["pi_deck_goal_mode"] = `${GOAL_MODE_RULES}\n\nObjective: ${state.objective}`;
			return {
				message: {
					customType: GOAL_CONTEXT_TYPE,
					content: roundLine,
					display: false,
				},
			};
		}
		const headline = ["[GOAL MODE ACTIVE]", `Objective: ${state.objective}`, `Round: ${state.roundsStarted + 1}/${state.maxGoalRounds}`].join("\n");
		return {
			message: {
				customType: GOAL_CONTEXT_TYPE,
				content: [headline, GOAL_MODE_RULES].join("\n\n"),
				display: false,
			},
		};
	});

	pi.on("context", async (event) => {
		if (state.enabled && state.phase === "active") return;
		return {
			messages: event.messages.filter((message) => {
				const typed = message as AgentMessage & { customType?: string };
				return String(typed.customType ?? "") !== GOAL_CONTEXT_TYPE;
			}),
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled || state.phase !== "active") return;

		const lastAssistant = Array.isArray(event?.messages)
			? [...event.messages].reverse().find(isAssistantMessage)
			: undefined;
		// 没有助手回复就不要续轮，避免空转把轮次烧光。
		if (!lastAssistant) {
			updateWidget(ctx);
			persistState();
			return;
		}
		// 桌面/用户主动中止（Stop 会话）或出错：不推进轮次、不自动续轮。
		// 若不检查 stopReason，agent_end 会把被中止的那轮当普通续轮再派发 followUp，
		// 刚被 Stop 的 agent 立刻又跑起来，表现为「点了停止会话却停不下来」。
		// 中止后保留 active/paused 原阶段，用户可再点恢复从当前进度继续。
		if (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") {
			updateWidget(ctx);
			persistState();
			return;
		}
		const text = getTextContent(lastAssistant);
		const terminal = text ? detectTerminal(text) : undefined;
		if (terminal?.phase === "complete") {
			setComplete(ctx);
			return;
		}
		if (terminal?.phase === "blocked") {
			setBlocked(ctx, terminal.reason);
			return;
		}

		state = { ...state, roundsStarted: state.roundsStarted + 1 };
		if (state.roundsStarted >= state.maxGoalRounds) {
			setBlocked(ctx, `reached max rounds (${state.maxGoalRounds})`);
			return;
		}
		updateWidget(ctx);
		persistState();

		// 同一会话自动续轮：不把续轮指令显示在时间线，避免刷屏。
		kickOffContinuation();
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const goalEntries = entries.filter((entry: { type: string; customType?: string }) =>
			entry.type === "custom" && entry.customType === GOAL_ENTRY_TYPE) as Array<{ data?: Partial<GoalModeState> }>;
		const latest = goalEntries[goalEntries.length - 1];
		// 目标全文只在变化时落盘（issue #366），从尾部往回找最近一条带 objective 的记录。
		// 遇 enabled:false 立即截断：那是 clear / 完成留下的记录，语义是「到此为止」。
		// 不截断就会穿透到更早的目标——历史里旧版 clear 不写 objective 字段，
		// 表现为「清除后重启旧目标复活」（issue #395）。
		let objective = "";
		for (let i = goalEntries.length - 1; i >= 0; i--) {
			const entry = goalEntries[i];
			if (entry.data?.enabled === false) break;
			if (typeof entry.data?.objective === "string") {
				objective = entry.data.objective;
				break;
			}
		}
		if (objective) {
			// 跨会话不自动续轮：恢复为 paused，避免打开历史会话就立刻烧一轮模型。
			state = {
				enabled: true,
				phase: "paused",
				objective,
				roundsStarted: latest.data.roundsStarted ?? 0,
				maxGoalRounds: latest.data.maxGoalRounds || DEFAULT_MAX_ROUNDS,
				blockReason: latest.data.blockReason,
			};
			// 恢复出来的目标必须同步 persistedObjective：否则下一次 clear 会误判「目标没变」
			// 而省略 objective，清除记不下来，再重启又回溯到旧目标（issue #395）。
			persistedObjective = objective;
		} else {
			state = {
				enabled: false,
				phase: "paused",
				objective: "",
				roundsStarted: 0,
				maxGoalRounds: DEFAULT_MAX_ROUNDS,
			};
		}
		updateWidget(ctx);
	});
}
