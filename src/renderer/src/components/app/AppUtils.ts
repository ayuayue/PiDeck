/**
 * 非组件工具函数，与 AppParts.tsx 分离以避免 Vite Fast Refresh 报错。
 * Fast Refresh 只支持组件和 hook（useXxx）导出，普通函数导出会导致整页刷新。
 */

import type { ReactNode } from "react";
import type { ChatMessage, FileTreeNode, PiCommand } from "../../../../shared/types";
import { isRetryStatusMessage } from "../session/timelineFailureNotice";
import type { TranslationKey } from "../../i18n";
import { formatFilePathRef } from "../session/composer/chips";
import { replaceExpandedRefBlocksWithLabels } from "../session/composer/quoteChip";

/* ── 文件树拖拽负载 ── */

/**
 * 文件树行拖拽时写入 dataTransfer 的两个 MIME：
 * - PI_FILE_PATH_DRAG_MIME：纯绝对路径，供「移动到目录」落点使用（历史约定，勿改名）。
 * - PI_FILE_NODE_DRAG_MIME：完整节点 JSON，composer 落点据此生成 @ 引用（区分文件/目录）。
 */
export const PI_FILE_PATH_DRAG_MIME = "text/pi-file-path";
export const PI_FILE_NODE_DRAG_MIME = "application/x-pi-file-node";

export interface FileNodeDragPayload {
	path: string;
	relativePath: string;
	type: "file" | "directory";
}

/** 拖拽开始侧：把节点信息写入 dataTransfer（路径 + JSON 双写，兼容只读路径的旧落点） */
export function writeFileNodeDragPayload(dataTransfer: DataTransfer, node: FileTreeNode): void {
	dataTransfer.setData(PI_FILE_PATH_DRAG_MIME, node.path);
	const payload: FileNodeDragPayload = {
		path: node.path,
		relativePath: node.relativePath,
		type: node.type,
	};
	dataTransfer.setData(PI_FILE_NODE_DRAG_MIME, JSON.stringify(payload));
}

/**
 * 落点侧：读取文件树拖拽负载。
 * 优先解析 JSON；只有纯路径时按「文件 + 绝对路径」兜底（兼容未带 JSON 的拖拽源）。
 * 非文件树拖拽（如 OS 文件拖入）返回 null。
 */
export function readFileNodeDragPayload(dataTransfer: DataTransfer): FileNodeDragPayload | null {
	const raw = dataTransfer.getData(PI_FILE_NODE_DRAG_MIME);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Partial<FileNodeDragPayload>;
			if (typeof parsed.path === "string" && parsed.path) {
				return {
					path: parsed.path,
					relativePath: typeof parsed.relativePath === "string" ? parsed.relativePath : "",
					type: parsed.type === "directory" ? "directory" : "file",
				};
			}
		} catch {
			// JSON 损坏时继续走纯路径兜底
		}
	}
	const plainPath = dataTransfer.getData(PI_FILE_PATH_DRAG_MIME);
	return plainPath ? { path: plainPath, relativePath: "", type: "file" } : null;
}

/**
 * 文件树节点 → composer @ 引用文本。
 * 项目内节点优先 relativePath（与 @ 建议一致，可过 chip 白名单校验）；
 * relativePath 缺失时退回绝对路径（chip 规则对绝对路径直接放行）。
 * 目录由 formatFilePathRef 追加尾斜杠，含空格路径自动加引号。
 */
export function fileNodeDragPayloadToRef(payload: FileNodeDragPayload): string {
	return formatFilePathRef(payload.relativePath || payload.path, {
		isDirectory: payload.type === "directory",
	});
}

/* ── ANSI 清理 ── */

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/* ── 时间和摘要 ── */

export function formatTime(timestamp: number) {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function summarizeMessage(text: string) {
	const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
}

/* ── 路径与匹配 ── */

export function matches(value: string, keyword: string) {
	return !keyword.trim() || value.toLowerCase().includes(keyword.trim().toLowerCase());
}

function getHomePathPrefix() {
	const match = location.href.match(/file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
	return match?.[1] ?? "C:/Users/14012";
}

export function displayPath(path?: string) {
	if (!path) return "";
	const home = getHomePathPrefix();
	const normalized = path.replace(/\\/g, "/");
	const friendly = home && normalized.toLowerCase().startsWith(home.toLowerCase()) ? `~${normalized.slice(home.length)}` : normalized;
	return friendly.length > 36 ? `...${friendly.slice(-35)}` : friendly;
}

/**
 * 将文件树展平为文件 + 目录列表。
 * 目录节点一并保留，供 @ 引用搜索与 chip 白名单使用（空目录也能被引用）。
 */
export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) => (node.type === "file" ? [node] : [node, ...flattenFiles(node.children ?? [])]));
}

/* ── 消息分组类型 ── */

export type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

export type MessageItem = { kind: "message"; message: ChatMessage };

/**
 * 重试过程条目：一轮 run 内的自动重试状态消息（正在重试/成功/最终失败）。
 * 与工具/思考同层，作为 run 的过程步骤参与折叠，不再渲染成时间线独立大卡片
 * ——旧形态与工具时间线割裂且顺序错乱（卡片插在工具调用与后续回答之间）。
 */
export type RetryGroupItem = {
	kind: "retry-group";
	/** 与消息 id 一致，保证 Live upsert（同 id 原地改写）映射稳定 */
	id: string;
	message: ChatMessage;
};

export type ThinkingGroupItem = {
	kind: "thinking-group";
	id: string;
	messages: ChatMessage[];
	text: string;
	startedAt: number;
	endedAt: number;
};

export type AgentRunItem = {
	kind: "agent-run";
	id: string;
	items: Array<MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem>;
	startedAt: number;
	endedAt: number;
	/** 本轮内 ask_question 的用户等待总时长（ms）：由已完成的 ask 工具消息推导，
	 *  回复耗时（endedAt - startedAt）需扣除这部分，等待段不计入 agent 处理时间。 */
	askWaitMs: number;
	/** 本轮是否阻塞在提问上（最后一条 ask 工具仍在等待回答）：尾部耗时应冻结而非持续跳动。 */
	askPending: boolean;
	/** 阻塞中的提问弹起时刻（ask 工具 beganAt），用于把尾部耗时冻结在该时刻。 */
	askPendingAt?: number;
};

export type RenderMessage = MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem | AgentRunItem;

/**
 * 生图占位消息的渲染身份：generating → error 往往只改 meta.imageGen，
 * 文本/图片/时间戳都不变。漏比这项时 reconcileRuns 会复用旧 run，
 * TurnRow memo 不重绘，界面一直停在「生图中」，直到切标签卸载重挂。
 */
function sameImageGenMetaForRender(previous: unknown, next: unknown): boolean {
	if (previous === next) return true;
	const prev = readImageGenRenderFields(previous);
	const nxt = readImageGenRenderFields(next);
	if (!prev && !nxt) return true;
	if (!prev || !nxt) return false;
	return prev.status === nxt.status && prev.prompt === nxt.prompt && prev.size === nxt.size && prev.errorDetail === nxt.errorDetail;
}

function readImageGenRenderFields(value: unknown): {
	status: string;
	prompt: string;
	size: string;
	errorDetail: string;
} | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("status" in value) || !("prompt" in value)) return null;
	const status = value.status;
	const prompt = value.prompt;
	if (typeof status !== "string" || typeof prompt !== "string") return null;
	const size = "size" in value && typeof value.size === "string" ? value.size : "";
	const errorDetail = "errorDetail" in value && typeof value.errorDetail === "string" ? value.errorDetail : "";
	return { status, prompt, size, errorDetail };
}

export function sameChatMessageForRender(previous: ChatMessage, next: ChatMessage): boolean {
	if (
		previous.id !== next.id ||
		previous.role !== next.role ||
		previous.text !== next.text ||
		previous.thinking !== next.thinking ||
		previous.timestamp !== next.timestamp ||
		// 空文本消息（纯工具回合骨架）的 stopReason 可能是唯一变化（pending→stop/toolUse），
		// 漏比较会导致 reconcileRuns 复用旧引用、最终/中间分类不更新。
		previous.stopReason !== next.stopReason ||
		!sameImageGenMetaForRender(previous.meta?.imageGen, next.meta?.imageGen)
	) {
		return false;
	}
	const previousImages = previous.images ?? [];
	const nextImages = next.images ?? [];
	return (
		previousImages.length === nextImages.length &&
		previousImages.every(
			(image, index) =>
				image.mimeType === nextImages[index]?.mimeType &&
				// 历史生图图片只有 ref 引用（没有 data）：两个不同的 ref 也必须判为不等，
				// 否则换图后复用旧引用会导致时间线不刷新。
				image.ref === nextImages[index]?.ref &&
				image.data === nextImages[index]?.data,
		)
	);
}

export function sameAgentRunForRender(previous: AgentRunItem, next: AgentRunItem): boolean {
	// 引用相同即内容相同（阶段0补强：历史 run 复用旧对象引用后，此处 O(1) 快速路径）
	if (previous === next) return true;
	if (previous.id !== next.id || previous.startedAt !== next.startedAt || previous.endedAt !== next.endedAt || previous.askWaitMs !== next.askWaitMs || previous.askPending !== next.askPending || previous.askPendingAt !== next.askPendingAt || previous.items.length !== next.items.length) {
		return false;
	}
	return previous.items.every((item, index) => {
		const other = next.items[index];
		if (!other || item.kind !== other.kind) return false;
		if (item.kind === "message" && other.kind === "message") {
			return sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "retry-group" && other.kind === "retry-group") {
			// 重试条目是同 id 原地 upsert（running→success/error 只改 meta/text），
			// 必须按消息本体比较，否则运行中→收敛的状态变化不会触发重绘。
			return item.id === other.id && sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "thinking-group" && other.kind === "thinking-group") {
			return item.id === other.id && item.text === other.text && item.startedAt === other.startedAt && item.endedAt === other.endedAt;
		}
		if (item.kind === "tool-group" && other.kind === "tool-group") {
			return item.id === other.id && item.messages.length === other.messages.length && item.messages.every((message, messageIndex) => sameChatMessageForRender(message, other.messages[messageIndex]));
		}
		return false;
	});
}

export function getMultiSelectImageCaptureIds(items: RenderMessage[], selectedIds: Set<string>): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (item.kind === "message") {
			if (selectedIds.has(item.message.id)) ids.add(item.message.id);
			continue;
		}
		if (item.kind === "agent-run") {
			const hasSelectedAssistant = item.items.some((sub) => sub.kind === "message" && sub.message.role === "assistant" && selectedIds.has(sub.message.id));
			if (hasSelectedAssistant) ids.add(item.id);
		}
	}
	return ids;
}

/* ── 消息分组 ── */

export function groupToolMessages(messages: ChatMessage[], options: { agentBusy?: boolean } = {}): RenderMessage[] {
	// agentBusy 决定 error 诊断卡是否打断当前 run（见下方 error 分支）
	const { agentBusy = false } = options;
	const result: RenderMessage[] = [];
	let currentTools: ChatMessage[] = [];
	let currentThinking: ChatMessage[] = [];
	let currentRun: Array<MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem> = [];
	let runStartedAt = 0;
	let runEndedAt = 0;
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
		if (currentRun.length === 0) return;

		// 不再合并连续 assistant 消息：issue #130 要求多段回答原位平铺，
		// 合并会把后段的 thinking 串接到前段消息上，导致思考被上移到两段文本之前。
		const runStableId = currentRun[0] ? (currentRun[0].kind === "message" ? currentRun[0].message.id : currentRun[0].id) : "";
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
		});
		currentRun = [];
		runStartedAt = 0;
		runEndedAt = 0;
		lastUserTimestamp = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushThinking();
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = message.timestamp;
		currentRun.push({ kind: "message", message });
	}

	/**
	 * 当前 run 里是否已包含上一个回合的「最终回答」（assistant 带 stopReason="stop"）。
	 *
	 * 用途：无触发消息的回合边界。pi 每轮最后一条 assistant 带 stopReason="stop"
	 * （中间消息为 toolUse，见 AgentMessageProjector 的 provider 归一化），所以 run 末尾
	 * 已出现 stop 又来了新的 assistant/tool/thinking，就说明新回合已经开始。
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
		}
		if (hasFinishedTurnInRun()) flushRun();
	}

	// 暂存区：仅用于 ask_question 续答——system 卡片后用户回复时，把卡片前的工具/思考
	// 暂存起来，等下一条 assistant 到来后合并为同一 agent-run。
	// 普通「上一轮只有工具/思考、用户又发新问题」场景不得使用此暂存，否则会串轮。
	let pendingRun: (MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem)[] | null = null;

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
			}
			appendRunMessage(message);
		} else if (message.role === "tool") {
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
			}
			if (currentRun.length === 0) {
				result.push({ kind: "message", message });
			} else {
				currentRun.push({ kind: "retry-group", id: message.id, message });
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
				flushRun();
			}
			result.push({ kind: "message", message });
		} else if (message.role === "error" && agentBusy) {
			// agent 忙碌中的 error 诊断卡（如扩展执行错误）：不中断当前 run。
			// 旧实现把 error 当用户消息处理（flush 当前 run），一段回答会被拆成
			// 两个 agent-run、错误卡夹在中间——用户体感「错误提示跑上旧卡片」。
			// 忙碌中的诊断卡作为独立条目先落盘，回答整体保持一个 run（卡在回答上方）。
			// 注意：空闲态（agentBusy=false）的 error 仍走 else 分支先 flush——
			// 此时 run 已结束，诊断卡应排在回答之后而不是之前。
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			result.push({ kind: "message", message });
		} else {
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
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
	}
	flushRun();

	return result;
}

/**
 * 对比新旧渲染列表，对「内容未变化的 run」复用旧对象引用。
 *
 * 背景（阶段0补强）：groupToolMessages 每次全量重建所有 run，即使只有最后一条消息变化。
 * 若每次都返回新对象，TurnRow 的 memo 比较（sameAgentRunForRender）会对每个历史 run
 * 做深度遍历，长会话时成本不小。复用旧引用后，sameAgentRunForRender 的
 * `previous === next` 快速路径直接命中，历史 run 比较退化为 O(1)。
 *
 * 规则：按 run.id 配对，内容相同（sameAgentRunForRender）则取旧引用；
 * 新增/删除/内容变化的 run 用新对象。列表结构（顺序、条目数）以 next 为准。
 */
export function reconcileRuns(previous: RenderMessage[] | undefined, next: RenderMessage[]): RenderMessage[] {
	if (!previous) return next;
	// 只对 agent-run 做引用复用；message/tool-group/thinking-group 顶层条目按需更新
	const prevRuns = new Map<string, AgentRunItem>();
	for (const item of previous) {
		if (item.kind === "agent-run") prevRuns.set(item.id, item);
	}
	let changed = false;
	const reconciled = next.map((item) => {
		if (item.kind !== "agent-run") return item;
		const prev = prevRuns.get(item.id);
		if (prev && sameAgentRunForRender(prev, item)) return prev;
		changed = true;
		return item;
	});
	// 只有「长度相同且全部未变化」才能整体复用 previous 数组本身；
	// 否则（新增/删除/变化）必须返回 reconciled（其中未变化 run 已复用旧引用）。
	if (!changed && previous.length === next.length) return previous;
	return reconciled;
}

/* ── 会话大纲 ── */

export function buildOutline(messages: ChatMessage[]) {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => ({
			id: message.id,
			role: message.role,
			// 定位轴标题是纯文本出口：先折叠自包含引用块，否则标题就是 <quoted_context …>
			title: summarizeMessage(replaceExpandedRefBlocksWithLabels(message.text)),
			time: formatTime(message.timestamp),
		}))
		.filter((item) => item.title);
}

/* ── 输入框建议 ── */

export type ComposerSuggestionResult = {
	text: string;
	cursor: number;
};

export type ComposerTrigger = {
	start: number;
	char: string;
	query: string;
};

/**
 * 触发符是否落在「可开建议」的边界上。
 * 与 chips.ts 的 lookbehind 对齐，并额外挡住 word&name / user@host，
 * 避免正文里的普通符号把建议框钉住。
 */
function isComposerTriggerBoundary(prev: string, char: string): boolean {
	if (!prev) return true;
	if (char === "&") {
		// chip 的 ampStartRe 已排除 :/.#!~?=&
		// 建议框再排除 \w：cmd&x、100%& 这种不当会话引用
		return !/[:/.#!~?=&\w]/.test(prev);
	}
	// @ / 与 parseRichInputChips 的 (?<![:/.\w#!~]) 一致
	return !/[:/.\w#!~]/.test(prev);
}

/**
 * & 后的查询是否仍像「正在输入某个已知会话名」。
 * 会话名可含空格（&beta long），所以不能一遇到空格就关；
 * 但必须是某个白名单名字的前缀，否则 Tom & Jerry 会永远开着建议框。
 */
function isSessionTriggerQuery(query: string, validSessionRefs: Set<string>): boolean {
	if (validSessionRefs.size === 0) return false;
	if (query.length === 0) return true;
	const needle = query.toLowerCase();
	for (const ref of validSessionRefs) {
		if (ref.toLowerCase().startsWith(needle)) return true;
	}
	return false;
}

export function detectTrigger(text: string, cursor: number, validSessionRefs?: Set<string>): ComposerTrigger | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length;
	const before = text.slice(0, cursor);
	const atIdx = before.lastIndexOf("@");
	const slashIdx = before.lastIndexOf("/");
	const ampIdx = before.lastIndexOf("&");
	const start = Math.max(atIdx, slashIdx, ampIdx);
	if (start < 0) return null;
	const char = before[start];
	const segment = before.slice(start + 1);
	const prev = start > 0 ? before[start - 1] : "";
	if (char === "&") {
		if (/\n/.test(segment)) return null;
		if (!isComposerTriggerBoundary(prev, "&")) return null;
		// 传入 Set（含 empty）= 严格白名单；未传则只认刚敲的孤立 &，
		// 避免「A & B」这种正文被当成未完成的会话引用。
		if (validSessionRefs) {
			if (!isSessionTriggerQuery(segment, validSessionRefs)) return null;
		} else if (segment.length > 0) {
			return null;
		}
		return { start, char, query: segment };
	}
	if (char === "/") {
		// 检查 / 是否属于 @file 路径（@ 在前且路径段内无空白），是则当作 @ 触发而非命令。
		// 关键：路径完成后光标后有空格/后续文本时（@src/ 说明…），必须关闭，
		// 否则路径中的每个 / 都会把建议框永久钉住。
		const beforeSlash = before.slice(0, start);
		const atBefore = beforeSlash.lastIndexOf("@");
		if (atBefore >= 0 && !/\s/.test(beforeSlash.slice(atBefore))) {
			const fileSegment = before.slice(atBefore + 1);
			if (/\s/.test(fileSegment)) return null;
			const atPrev = atBefore > 0 ? before[atBefore - 1] : "";
			if (!isComposerTriggerBoundary(atPrev, "@")) return null;
			return { start: atBefore, char: "@", query: fileSegment };
		}
	}
	if (/[\s@/&]/.test(segment)) return null;
	if (!isComposerTriggerBoundary(prev, char)) return null;
	return { start, char, query: segment };
}

export function applySuggestion(current: string, cursor: number, value: string, validSessionRefs?: Set<string>, options?: { noTrailingSpace?: boolean }): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor, validSessionRefs);
	// 目录引用（@dir/）不带尾随空格：插入后用户继续输入路径段时，
	// 建议框会随每次按键重新评估打开，形成连续向下钻取；
	// 文件/命令引用保持默认空格，避免与后续正文粘连。
	const suffix = options?.noTrailingSpace ? "" : " ";
	if (!trigger) {
		// 无触发时插在光标处，而不是一律拼到文末——否则误开的建议框选中后
		// 会把光标/正文一起拽到结尾。
		const text = `${current.slice(0, cursor)}${value}${suffix}${current.slice(cursor)}`;
		return { text, cursor: cursor + value.length + suffix.length };
	}
	const text = `${current.slice(0, trigger.start)}${value}${suffix}${current.slice(cursor)}`;
	return { text, cursor: trigger.start + value.length + suffix.length };
}

/**
 * 关闭建议框时的文本处理。
 * 默认只关面板、不改输入——用户可能已在 @path 后继续写说明文字，
 * 若删掉从触发符到光标的整段，会把正文一起清掉（Esc 全没了）。
 * 仅当「触发后还没有任何有效查询」时（刚输入 @ / &）才去掉触发符本身，避免残留孤立符号。
 */
export function clearSuggestionTrigger(current: string, cursor: number, validSessionRefs?: Set<string>): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor, validSessionRefs);
	if (!trigger) return { text: current, cursor };
	// 已有查询内容：保留全文，只表示关闭菜单
	if (trigger.query.length > 0) {
		return { text: current, cursor };
	}
	// 空触发符（单独的 @ / &）：去掉触发符，避免占位
	const text = `${current.slice(0, trigger.start)}${current.slice(cursor)}`;
	return { text, cursor: trigger.start };
}

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
	/** 不可选中的分组头；目录本身可选，不再使用 disabled 表示目录 */
	disabled?: boolean;
	/** 树形缩进层级（0=根目录），仅在 @ 无关键词时使用 */
	treeDepth?: number;
	/** 目录引用：UI 显示文件夹图标，插入路径与文件相同 */
	isDirectory?: boolean;
	sessionMeta?: { sessionId: string; filePath: string; projectPath?: string };
};

/* ── 命令管理 ── */

const PINNED_COMMAND_NAMES = new Set<string>();
// 桌面端已有独立 UI 的 pi 内置命令不进 `/` 菜单，避免点进去却落到 CLI 语义。
// `/new` 例外：发送时由桌面拦截，走新建 Agent 会话（与侧栏 + 同源），不再藏起来。
const HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES = new Set(["model", "resume", "fork", "name", "logout", "goal", "tree", "reload"]);

function isBuiltinDesktopCommand(command: PiCommand) {
	return command.source == null || command.source === "builtin";
}

function isVisibleDesktopCommand(command: PiCommand) {
	return !(isBuiltinDesktopCommand(command) && HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES.has(command.name.toLowerCase()));
}

function getBuiltinCommands(): PiCommand[] {
	return [
		{ name: "new", description: "", source: "builtin" },
		{ name: "session", description: "", source: "builtin" },
		{ name: "tree", description: "", source: "builtin" },
		{ name: "clone", description: "", source: "builtin" },
		{ name: "compact", description: "", source: "builtin" },
		{ name: "copy", description: "", source: "builtin" },
		{ name: "export", description: "", source: "builtin" },
		{ name: "share", description: "", source: "builtin" },
		{ name: "settings", description: "", source: "builtin" },
		{ name: "reload", description: "", source: "builtin" },
		{ name: "hotkeys", description: "", source: "builtin" },
		{ name: "login", description: "", source: "builtin" },
		{ name: "logout", description: "", source: "builtin" },
	];
}

/**
 * DSH 已知斜杠命令建议（G4）：与 dsh-web 命名空间一致——host 侧 pideck-slash-bridge
 * 在 agent/pre-step 拦截执行，未命中（未知命令）放行给模型。列表仅作 Composer `/` 菜单
 * 建议，不参与执行正确性。description 用 i18n key（controller 注入时翻译）。
 */
export const DSH_COMMAND_SUGGESTIONS: Array<{ name: string; descriptionKey: TranslationKey; source: "dsh" }> = [
	{ name: "permission", descriptionKey: "dshCommand.permission", source: "dsh" },
	{ name: "plan", descriptionKey: "dshCommand.plan", source: "dsh" },
	{ name: "plan off", descriptionKey: "dshCommand.planOff", source: "dsh" },
	{ name: "compact", descriptionKey: "dshCommand.compact", source: "dsh" },
	{ name: "help", descriptionKey: "dshCommand.help", source: "dsh" },
	{ name: "goal", descriptionKey: "dshCommand.goal", source: "dsh" },
	{ name: "subagent", descriptionKey: "dshCommand.subagent", source: "dsh" },
	{ name: "feedback", descriptionKey: "dshCommand.feedback", source: "dsh" },
];

export function mergeCommands(commands: PiCommand[]) {
	const visibleCommands = commands.filter(isVisibleDesktopCommand);
	const names = new Set(visibleCommands.map((command) => command.name));
	const extras = getBuiltinCommands().filter((command) => !names.has(command.name) && isVisibleDesktopCommand(command));
	return [...visibleCommands, ...extras];
}

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

/** 目录引用在建议列表与插入文本中都用尾斜杠标记，避免 @src 被模型当成智能体。 */
function formatPathSuggestionLabel(node: FileTreeNode): string {
	return node.type === "directory" ? `@${node.name}/` : `@${node.name}`;
}

function formatPathSuggestionValue(node: FileTreeNode): string {
	return formatFilePathRef(node.relativePath, {
		isDirectory: node.type === "directory",
	});
}

/**
 * 建议列表的辅助描述：只显示父目录（根层用 .）。
 * 完整相对路径太长且文件名才是辨识关键——label 已展示文件名，
 * description 用父目录帮用户确认层级位置即可。
 */
function formatPathSuggestionDescription(relativePath: string): string {
	const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
	if (parts.length <= 1) return ".";
	return parts.slice(0, -1).join("/");
}

/**
 * 从扁平路径列表（文件 + 目录）重建一级树视图。
 * 目录与文件均可选，便于直接 @src 这类目录引用。
 */
function buildFileTreeItems(entries: FileTreeNode[]): SuggestionItem[] {
	interface PathNode {
		name: string;
		relativePath: string;
		children: Map<string, PathNode>;
		files: FileTreeNode[];
		dirNode?: FileTreeNode;
	}
	// 用 / 分隔符构建路径树；目录节点单独挂 dirNode，空目录也能出现。
	const root: PathNode = { name: "", relativePath: "", children: new Map(), files: [] };
	const ensureDir = (parent: PathNode, part: string): PathNode => {
		let child = parent.children.get(part);
		if (!child) {
			const relativePath = parent.relativePath ? `${parent.relativePath}/${part}` : part;
			child = { name: part, relativePath, children: new Map(), files: [] };
			parent.children.set(part, child);
		}
		return child;
	};
	for (const entry of entries) {
		const parts = entry.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0) continue;
		if (entry.type === "directory") {
			let node = root;
			for (const part of parts) node = ensureDir(node, part);
			node.dirNode = entry;
			continue;
		}
		let node = root;
		for (const part of parts.slice(0, -1)) node = ensureDir(node, part);
		node.files.push(entry);
	}
	// 仅展平第一层（根目录文件 + 一级目录），避免大项目卡顿
	const result: SuggestionItem[] = [];
	function flatten(node: PathNode, depth: number, maxDepth: number) {
		const sortedDirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
		const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
		for (const dir of sortedDirs) {
			const dirPath = dir.dirNode?.relativePath ?? dir.relativePath;
			result.push({
				key: dir.dirNode?.path ?? `dir:${dirPath}`,
				label: `@${dir.name}/`,
				description: formatPathSuggestionDescription(dirPath),
				// 必须插入 @dir/：裸 @dir 无法过 chip 路径规则，也易被模型当成 mention
				value: formatFilePathRef(dirPath, { isDirectory: true }),
				treeDepth: depth,
				isDirectory: true,
			});
			if (depth < maxDepth) flatten(dir, depth + 1, maxDepth);
		}
		for (const file of sortedFiles) {
			result.push({
				key: file.path,
				label: formatPathSuggestionLabel(file),
				description: formatPathSuggestionDescription(file.relativePath),
				value: formatPathSuggestionValue(file),
				treeDepth: depth,
				isDirectory: file.type === "directory",
			});
		}
	}
	flatten(root, 0, 0); // 只展开第一层
	return result;
}

export function buildSuggestionItems(prompt: string, cursor: number, commands: PiCommand[], files: FileTreeNode[], sessions?: { id: string; filePath: string; projectPath?: string; name?: string; preview: string; updatedAt: number }[]): SuggestionItem[] {
	const allCommands = mergeCommands(commands);
	// 与 onChange 同一套白名单：& 只有仍是已知会话名前缀时才开建议
	const sessionRefs = sessions ? new Set(sessions.map((session) => session.name ?? session.filePath)) : undefined;
	const trigger = detectTrigger(prompt, cursor, sessionRefs);
	if (!trigger) return [];
	const keyword = trigger.query.toLowerCase();
	if (trigger.char === "/") {
		return allCommands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) => command.name.toLowerCase().includes(keyword))
			.sort((a, b) => {
				const aPinned = PINNED_COMMAND_NAMES.has(a.command.name);
				const bPinned = PINNED_COMMAND_NAMES.has(b.command.name);
				if (aPinned !== bPinned) return aPinned ? -1 : 1;
				return a.index - b.index;
			})
			.map(({ command }) => ({
				key: command.name,
				label: `/${command.name}`,
				description: command.description ?? "",
				value: `/${command.name}`,
			}));
	}
	if (trigger.char === "@") {
		if (!keyword) {
			// 无关键词：展示一级目录/文件；目录可直接选中引用
			return buildFileTreeItems(files);
		}
		// 有关键词：文件与目录一起模糊搜索；同名时目录略优先，方便找文件夹
		return files
			.map((file) => ({
				file,
				score: fuzzyScore(file.relativePath, keyword) + fuzzyScore(file.name, keyword) * 2 + (file.type === "directory" ? 4 : 0),
			}))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 15)
			.map((item) => ({
				key: item.file.path,
				label: formatPathSuggestionLabel(item.file),
				description: formatPathSuggestionDescription(item.file.relativePath),
				// 相对路径含空格时同样加引号；目录追加 / 以通过 chip 规则并语义化为路径。
				value: formatPathSuggestionValue(item.file),
				isDirectory: item.file.type === "directory",
			}));
	}
	if (trigger.char === "&") {
		const list = sessions ?? [];
		return list
			.map((s) => ({ session: s, score: fuzzyScore(s.name ?? s.filePath, keyword) + fuzzyScore(s.preview ?? "", keyword) }))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				// key 用会话 id：DSH 会话没有文件路径，用 filePath 会与其它会话撞 key
				key: item.session.id,
				label: item.session.name ?? item.session.filePath,
				description: item.session.preview,
				value: `&${item.session.name ?? item.session.filePath}`,
				sessionMeta: { sessionId: item.session.id, filePath: item.session.filePath, projectPath: item.session.projectPath },
			}));
	}
	return [];
}

/* ── 工具参数解析 ── */

export function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "string" && parsed.trim()) {
			try {
				parsed = JSON.parse(parsed);
			} catch {
				return undefined;
			}
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function getToolFilePath(args: unknown): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try {
			args = JSON.parse(args);
		} catch {
			return undefined;
		}
	}
	if (typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	return typeof a.filePath === "string" && a.filePath
		? a.filePath
		: typeof a.file_path === "string" && a.file_path
			? a.file_path
			: typeof a.path === "string" && a.path
				? a.path
				: typeof a.targetPath === "string" && a.targetPath
					? a.targetPath
					: typeof a.target_path === "string" && a.target_path
						? a.target_path
						: typeof a.outputPath === "string" && a.outputPath
							? a.outputPath
							: typeof a.output_path === "string" && a.output_path
								? a.output_path
								: typeof a.file === "string" && a.file
									? a.file
									: typeof a.fileName === "string" && a.fileName
										? a.fileName
										: typeof a.filename === "string" && a.filename
											? a.filename
											: undefined;
}

export function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

export function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits
			.map((edit: unknown) => {
				if (!edit || typeof edit !== "object") return null;
				const e = edit as Record<string, unknown>;
				const oldText = String(e.oldText ?? e.old_text ?? e.old_string ?? "");
				const newText = String(e.newText ?? e.new_text ?? e.new_string ?? "");
				return { oldText, newText };
			})
			.filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map((p) => p.oldText).join("\n"),
			newText: parts.map((p) => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

export function getToolNewContent(toolName: string, args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try {
			args = JSON.parse(args);
		} catch {
			return undefined;
		}
	}
	if (!toolName) return undefined;
	if (/write|create/i.test(toolName)) {
		const a = args as Record<string, unknown>;
		return typeof a.content === "string" ? a.content : typeof a.text === "string" ? a.text : typeof a.data === "string" ? a.data : typeof a.body === "string" ? a.body : undefined;
	}
	if (/edit|patch/i.test(toolName)) {
		const diff = getToolEditDiff(args);
		return diff?.newText;
	}
	return undefined;
}

export function getToolChangedLineCount(toolName: string, args: any): number {
	if (typeof args === "string" && args.trim()) {
		try {
			args = JSON.parse(args);
		} catch {
			return 0;
		}
	}
	if (!toolName) return 0;
	if (/edit|patch/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		if (edits) {
			return edits.reduce((total: number, edit: any) => {
				const oldLines = countTextLines(String(edit?.oldText ?? edit?.old_text ?? ""));
				const newLines = countTextLines(String(edit?.newText ?? edit?.new_text ?? ""));
				return total + Math.max(oldLines, newLines);
			}, 0);
		}
		return Math.max(countTextLines(String(args?.oldText ?? args?.old_text ?? "")), countTextLines(String(args?.newText ?? args?.new_text ?? "")));
	}
	if (/write|create/i.test(toolName)) {
		return countTextLines(String(args?.content ?? args?.text ?? args?.data ?? args?.body ?? ""));
	}
	return 0;
}
