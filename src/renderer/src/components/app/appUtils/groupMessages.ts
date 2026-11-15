/**
 * 从 AppUtils 拆出的「消息分组」域：把扁平消息列表装配成时间线条目（agent-run / 工具组 / 思考组 / 重试 / 错误 / 扩展输出）。
 * 这里是回合边界的唯一裁决处，改动前先读 groupToolMessages 内的边界注释。
 */

import type { ChatMessage } from "../../../../../shared/types";
import { stripAnsiCsi as stripAnsi } from "../../../../../shared/ansiText";
import { isRetryStatusMessage } from "../../session/timelineFailureNotice";
import type { AgentRunItem, ErrorGroupItem, ExtensionEntryGroupItem, MessageItem, RenderMessage, RetryGroupItem, ThinkingGroupItem, ToolGroupItem } from "./renderTypes";
import { stripThinkingTags } from "./textFormat";

/* ── 消息分组 ── */

/**
 * 消息在墙钟时间上的结束点。
 *
 * assistant 的 `timestamp` 是请求开始（pi 语义），终态消息另有 `meta.endedAt`
 * （请求开始 + 实测耗时；无实测耗时的后端为终态事件到达时刻）。轮末固定耗时
 * 必须用结束点相减——用 `timestamp` 会把「回复耗时」算成最后一次请求的排队时间，
 * 流式结束后与 `startedAt` 相等时甚至恒为 0。历史/旧数据缺 `endedAt` 时回退 timestamp。
 */
export function messageEndedAt(message: ChatMessage): number {
	const endedAt = message.meta?.endedAt;
	return typeof endedAt === "number" && Number.isFinite(endedAt) && endedAt > 0 ? endedAt : message.timestamp;
}

export function groupToolMessages(messages: ChatMessage[], options: { agentBusy?: boolean } = {}): RenderMessage[] {
	// agentBusy 决定 error 诊断卡是否打断当前 run（见下方 error 分支）
	const { agentBusy = false } = options;
	const result: RenderMessage[] = [];
	let currentTools: ChatMessage[] = [];
	let currentThinking: ChatMessage[] = [];
	let currentRun: Array<MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem | ErrorGroupItem | ExtensionEntryGroupItem> = [];
	let runStartedAt = 0;
	let runEndedAt = 0;
	/** 当前 run 内被时间线隐藏、但需参与文件汇总的工具消息（见 AgentRunItem.hiddenFileMessages）。 */
	let currentHiddenFileMessages: ChatMessage[] = [];
	/** 当前回合的触发用户消息时间戳，用于替代 assistant/tool 时间戳作为回合起点 */
	let lastUserTimestamp = 0;

	function isThinkingOnly(message: ChatMessage) {
		return message.role === "assistant" && Boolean(message.thinking?.trim()) && !stripThinkingTags(stripAnsi(message.text)).trim();
	}

	function flushThinking() {
		if (currentThinking.length === 0) return;
		// 每条 thinking-only 各自成组：id 与主进程 msg-thinking-* 一一对应，禁止 join 合并。
		for (const message of currentThinking) {
			const rawId = message.id ?? "";
			const group: ThinkingGroupItem = {
				kind: "thinking-group",
				id: rawId.startsWith("msg-thinking-") ? rawId : `msg-thinking-${rawId}`,
				messages: [message],
				text: stripAnsi(message.thinking ?? ""),
				startedAt: message.thinkingStartedAt ?? message.timestamp ?? runStartedAt,
				endedAt: message.thinkingEndedAt ?? message.timestamp ?? runEndedAt,
			};
			currentRun.push(group);
			runEndedAt = group.endedAt;
		}
		currentThinking = [];
	}

	function flushTools() {
		if (currentTools.length === 0) return;
		flushThinking();
		// 使用首个工具消息 ID 作为稳定 key，与 flushThinking 同理。
		const stableId = currentTools[0]?.id ?? "";
		const group: ToolGroupItem = {
			kind: "tool-group",
			id: stableId,
			messages: currentTools,
		};
		currentRun.push(group);
		runEndedAt = currentTools[currentTools.length - 1]?.timestamp ?? runEndedAt;
		currentTools = [];
	}

	function flushRun() {
		flushTools();
		flushThinking();
		// 只有隐藏文件消息的轮也要成组：PTC 会话常见「agent 静默改文件、本轮没有任何可见
		// 文本或工具」——若在这里提前返回，轮末 chip 行会整个消失（用户看不到本轮改了什么）。
		// 这种 run 的 items 为空，时间线不渲染任何内容，仅提供 chip 行数据。
		if (currentRun.length === 0 && currentHiddenFileMessages.length === 0) return;

		// 不再合并连续 assistant 消息：issue #130 要求多段回答原位平铺，
		// 合并会把后段的 thinking 串接到前段消息上，导致思考被上移到两段文本之前。
		const runStableId = currentRun.length > 0 ? (currentRun[0].kind === "message" ? currentRun[0].message.id : currentRun[0].id) : `hidden-files:${currentHiddenFileMessages[0]?.id ?? "run"}`;
		// 汇总本轮 ask_question 的用户等待时长：等待段不计入「回复耗时」。
		// ask_question 工具结束时主进程已把等待从 durationMs 中扣除（见 AgentManager
		// settleAskWait / upsertToolMessage），因此每笔等待量可反推：
		//   等待 = (工具结束时间戳 - meta.startedAt) - durationMs
		// 只有结束时间戳 / startedAt / durationMs 三者齐备才能反推（历史消息缺 durationMs
		// 时按 0 处理，退化为旧行为）。运行中的 ask（meta.status === "running"，结果未落地
		// 所以没有 _askCard）意味着整轮阻塞在提问上，尾部耗时需冻结在提问时刻。
		let askWaitMs = 0;
		let askPending = false;
		let askPendingAt: number | undefined;
		for (const item of currentRun) {
			if (item.kind !== "tool-group") continue;
			for (const message of item.messages) {
				if (message.role !== "tool") continue;
				const meta = message.meta;
				if (typeof meta?.toolName !== "string" || meta.toolName.toLowerCase() !== "ask_question") continue;
				if (meta.status === "running") {
					askPending = true;
					if (typeof meta.startedAt === "number") askPendingAt = meta.startedAt;
					continue;
				}
				const { startedAt, durationMs } = meta;
				if (typeof startedAt === "number" && typeof durationMs === "number") {
					askWaitMs += Math.max(0, message.timestamp - startedAt - durationMs);
				}
			}
		}
		result.push({
			kind: "agent-run",
			id: runStableId,
			items: currentRun,
			// 回合起点优先用触发它的用户消息时间戳，无用户消息时回退到 run 内首条消息时间戳
			startedAt: lastUserTimestamp || runStartedAt,
			endedAt: runEndedAt || runStartedAt,
			askWaitMs,
			askPending,
			...(askPendingAt !== undefined ? { askPendingAt } : {}),
			...(currentHiddenFileMessages.length > 0 ? { hiddenFileMessages: currentHiddenFileMessages } : {}),
		});
		currentRun = [];
		currentHiddenFileMessages = [];
		runStartedAt = 0;
		runEndedAt = 0;
		lastUserTimestamp = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushThinking();
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = messageEndedAt(message);
		currentRun.push({ kind: "message", message });
	}

	/**
	 * 当前 run 里是否已包含上一个回合的「最终回答」（assistant 带 stopReason="stop"）。
	 *
	 * 用途：无触发消息的回合边界。pi 每轮最后一条 assistant 带 stopReason="stop"
	 * （中间消息为 toolUse，见 AgentMessageProjector 的 provider 归一化），所以 run 末尾
	 * 已出现 stop 又来了新的 assistant/tool/thinking/扩展输出，就说明新回合已经开始。
	 *
	 * 典型场景：父回合已结束，后台子代理完成时 pi 用 sendCustomMessage(triggerTurn)
	 * 唤醒父会话；（a）唤醒消息是 role="custom"，旧实现整条丢弃 —— 既不可见也没有
	 * 边界；（b）两个回合于是合并成一个 run，于是上一轮最终回答退化为「中间回答」被
	 * 折叠，新回合内容变成时间线末尾的最终回答——用户反馈的「输出被折叠、后面的变成
	 * 最后」。这里按 stopReason 断开，即使唤醒消息没进消息列表也不会串轮。
	 * 只看 run 内最后一条 assistant：它才是「本轮是否已收尾」的判据。
	 */
	function hasFinishedTurnInRun() {
		for (let i = currentRun.length - 1; i >= 0; i -= 1) {
			const item = currentRun[i];
			if (item.kind !== "message" || item.message.role !== "assistant") continue;
			return item.message.stopReason === "stop";
		}
		return false;
	}

	/** 回合边界收口：把暂存 run 并在当前 run 后整体 flush（无副作用，无内容时不做事）。 */
	function flushRunForTurnBoundary() {
		if (pendingRun) {
			currentRun.push(...pendingRun);
			pendingRun = null;
			restorePendingHidden();
		}
		if (hasFinishedTurnInRun()) flushRun();
	}

	// 暂存区：仅用于 ask_question 续答——system 卡片后用户回复时，把卡片前的工具/思考
	// 暂存起来，等下一条 assistant 到来后合并为同一 agent-run。
	// 普通「上一轮只有工具/思考、用户又发新问题」场景不得使用此暂存，否则会串轮。
	let pendingRun: (MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem | ErrorGroupItem | ExtensionEntryGroupItem)[] | null = null;
	/** pendingRun 的隐藏文件消息伙伴：跟随 currentRun 一同暂存/回填，避免跨段落错位。 */
	let pendingHiddenFileMessages: ChatMessage[] | null = null;

	/** 把暂存的隐藏文件消息回填到当前 run（必须紧跟每次 pendingRun 回填，否则跨段串数据）。 */
	function restorePendingHidden() {
		if (!pendingHiddenFileMessages) return;
		currentHiddenFileMessages.push(...pendingHiddenFileMessages);
		pendingHiddenFileMessages = null;
	}

	for (const message of messages) {
		if (isThinkingOnly(message)) {
			flushTools();
			// 上一回合已收尾（末尾 assistant 带 stop）：这个 thinking 属于新回合，先断开
			flushRunForTurnBoundary();
			if (currentRun.length === 0 && currentThinking.length === 0) {
				runStartedAt = message.timestamp;
			}
			currentThinking.push(message);
			runEndedAt = message.timestamp;
			// 立即成组：禁止多条 thinking-only 积压后 join 成一张卡。
			flushThinking();
		} else if (message.role === "assistant") {
			// 无触发消息的新回合（如后台子代理唤醒）先断开，避免上一轮最终回答被折叠
			flushRunForTurnBoundary();
			// 有暂存 run 时先合并到当前 run
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				restorePendingHidden();
			}
			appendRunMessage(message);
		} else if (message.role === "tool") {
			// 隐藏工具卡（meta.ptcNested）：DSH run_code 程序内部的文件类子调用（write/edit…）、
			// ACP 多文件 diff 的其余文件——只喂文件聚合，不进时间线。
			// 时间线仍只展示外层 run_code 卡——否则一轮 PTC 会凭空冒出几十张嵌套工具卡。
			// 但**不能直接丢弃**：这类消息是 PTC 会话「修改的文件」的唯一数据源（run_code 永远
			// 命中不到 write/edit 工具名）。直接丢弃会让轮末 chip 行对 PTC 会话恒为空。
			// 因此收进 hiddenFileMessages（不进 items，不渲染），供 collectRunFileChanges 聚合。
			// 必须在任何分组动作（flushRunForTurnBoundary/flushThinking）之前处理：
			// 隐藏消息不应制造回合边界，也不能把思考组打散。
			if (message.meta?.ptcNested === true) {
				currentHiddenFileMessages.push(message);
				// 隐藏消息也要撑起轮内时间轴：若本轮没有任何可见内容，
				// startedAt/endedAt 只能靠它们推导（否则 chip 行所属轮的时间为 0）。
				if (currentRun.length === 0 && runStartedAt === 0) runStartedAt = message.timestamp;
				runEndedAt = message.timestamp;
				continue;
			}
			// 新回合可能直接从工具开始（唤醒后先调用工具），同样需要先断开
			flushRunForTurnBoundary();
			flushThinking();
			if (currentRun.length === 0) runStartedAt = message.timestamp;
			currentTools.push(message);
		} else if (isRetryStatusMessage(message)) {
			// 自动重试状态消息（正在重试/成功/最终失败）收进当前 run 的过程序列：
			// 它是本轮请求生命周期的一部分，应与工具/思考同层展示（折叠行），而不是
			// 独立大卡片插在工具与后续回答之间（旧形态的割裂/错序根因）。
			// 先冲刷未成组的工具/思考（flushTools 内含 flushThinking），保证重试行
			// 在 run 内严格晚于它之前的工具——否则工具会在 retry 之后才成组、顺序颠倒。
			// 边界：run 尚未开始（如首轮请求立即失败、无任何工具/思考/回答）时保持
			// 独立条目不硬塞——否则会凭空造出一个只有重试行的空 run。
			flushTools();
			if (pendingRun && currentRun.length === 0) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				restorePendingHidden();
			}
			if (currentRun.length === 0) {
				result.push({ kind: "message", message });
			} else {
				currentRun.push({ kind: "retry-group", id: message.id, message });
				runEndedAt = message.timestamp;
			}
		} else if (message.role === "system" && message.meta?.type === "customEntry") {
			// 扩展输出条目（appendEntry 投影卡）：与重试/错误同策略收进当前 run 的过程序列，
			// 折进过程组（用户决策 2026-10：不单独成块）。先冲刷未成组的工具/思考保证时序；
			// 连续到达的条目合进同一个组员（时间线里渲染为一组可展开行）。
			// 已收尾回合（最后一条 assistant 带 stop）之后才到的扩展输出不属于该回合：
			// 继续吸收会让它成为 run 的收尾条目，前面的最终回答因此被降级成中间回答折叠
			// （bili 的 acp-nudge 等尾随通知的实际表现，2026-10 用户反馈）。先按回合边界
			// 冲刷，随后 currentRun 为空 → 走下面的独立条目兜底，输出卡排在回答之后。
			// 边界：run 尚未开始（会话开头/两回合之间的条目）保持独立条目兜底，不硬造空 run。
			flushRunForTurnBoundary();
			flushTools();
			if (pendingRun && currentRun.length === 0) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				restorePendingHidden();
			}
			if (currentRun.length === 0) {
				result.push({ kind: "message", message });
			} else {
				const last = currentRun[currentRun.length - 1];
				if (last.kind === "extension-entries") {
					// 不可变追加，不要 `last.messages.push(message)`。
					//
					// 就地 push 会把「引用相等 = 内容相等」这个前提打掉：`sameRunItemReference`
					// 的 extension-entries 分支判 `a.messages === b.messages`，同一数组被就地改了
					// 之后两版永远相等 → 永远复用旧条目 → 下游 `ExtensionEntryStep` 的 memo
					// 看到同一引用、认为内容没变，**新消息卡永不出现**（也不是报错，是静默冻结）。
					// 换新数组后引用随内容变化，「引用相等 ⇔ 内容相等」这条不变量重新成立。
					currentRun[currentRun.length - 1] = {
						...last,
						messages: [...last.messages, message],
					};
				} else {
					currentRun.push({ kind: "extension-entries", id: message.id, messages: [message] });
				}
				runEndedAt = message.timestamp;
			}
		} else if (message.role === "system") {
			// System 消息（如 askQuestion 卡片）不应中断当前 agent run。
			// 工具、thinking 和后续 assistant 消息应合并为同一轮回答，
			// 否则会被拆成两个独立的折叠区域。
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉。
			//
			// 例外：扩展 custom 消息（meta.type === "customMessage"）本身是回合边界
			// ——pi 在回合之间写入 custom_message 条目（如后台子代理完成唤醒），
			// 卡片要正好落在两轮之间，否则后续回合会与上一轮合并、最终回答被折叠。
			// 未渲染的 custom（display:false 的上下文注入）同样断开：不可见但边界真实。
			const isCustomMessage = message.meta?.type === "customMessage";
			if (isCustomMessage) {
				flushRunForTurnBoundary();
			} else if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				restorePendingHidden();
				flushRun();
			}
			result.push({ kind: "message", message });
		} else if (message.role === "error" && agentBusy) {
			// agent 忙碌中的 error 诊断消息（请求失败 429 / 扩展执行错误等）：收进当前 run
			// 的过程序列（与自动重试同策略，用户反馈：429 错误卡应并入工具调用、可点开看详情）。
			// 旧实现把 error 当独立卡片：位于工具与后续回答之间，与工具时间线割裂且顺序错乱。
			// 边界：run 尚未开始（如首轮请求立即失败、无任何工具/思考/回答）时保持独立条目
			// 不硬塞——否则会凭空造出一个只有错误行的空 run；此时后续重试/回答自成新 run。
			flushTools();
			if (pendingRun && currentRun.length === 0) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				restorePendingHidden();
			}
			if (currentRun.length === 0) {
				result.push({ kind: "message", message });
			} else {
				currentRun.push({ kind: "error-group", id: message.id, message });
				runEndedAt = message.timestamp;
			}
		} else {
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				restorePendingHidden();
				flushRun();
			}
			// 用户消息到来时，当前 run 可能只有工具/思考、没有最终回答文本。
			// 仅在「回答 ask_question」场景下暂存合并：上一条 result 是 system 消息。
			// 普通新提问（上一轮未完成回答就发下一条）必须 flush 成独立 agent-run，
			// 否则上一轮的工具/思考会混进下一轮回答块。
			const hasToolsWithoutAssistant = currentRun.length > 0 && currentRun.every((i) => i.kind !== "message" || i.message.role !== "assistant");
			const lastResult = result[result.length - 1];
			// error 诊断卡也可能插在 ask 卡片之后（非 busy 路径），
			// 用户回复时同样视为回答 ask，避免工具/思考串轮。
			const isAnsweringAskQuestion = lastResult?.kind === "message" && (lastResult.message.role === "system" || lastResult.message.role === "error");
			if (hasToolsWithoutAssistant && isAnsweringAskQuestion) {
				flushTools();
				flushThinking();
				pendingRun = [...currentRun];
				currentRun = [];
				// 隐藏文件消息跟随暂存：它们属于刚结束的这一段，不能潦到续答后的新段。
				if (currentHiddenFileMessages.length > 0) {
					pendingHiddenFileMessages = [...currentHiddenFileMessages];
					currentHiddenFileMessages = [];
				}
				runStartedAt = 0;
				runEndedAt = 0;
			} else {
				flushRun();
			}
			result.push({ kind: "message", message });
			// 记录触发回合的用户消息时间戳，作为回合的真实起点
			lastUserTimestamp = message.timestamp;
		}
	}
	// 最后 flush 当前 run（含合并后的暂存 run）
	if (pendingRun) {
		currentRun.push(...pendingRun);
		pendingRun = null;
		restorePendingHidden();
	}
	flushRun();

	return result;
}
