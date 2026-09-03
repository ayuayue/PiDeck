/**
 * AgentManager 纯工具函数。
 * Phase 1.3: 从 AgentManager.ts 中提取，无副作用，不依赖实例状态。
 */

import type { ChatMessage, Project } from "../../shared/types";
import { looksLikePiSessionFileStem } from "../../shared/sessionIdentity";

export { looksLikePiSessionFileStem } from "../../shared/sessionIdentity";

/** 去除 ANSI 转义码，用于清洗 thinking 中的终端颜色控制序列。 */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** 从参数列表中取首个有效数字。 */
export function pickNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

/** 钳制百分比到 0-100 范围。 */
export function clampPercent(value: number | undefined): number | undefined {
	if (value == null || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

/**
 * 解析系统通知点击的会话跳转目标。
 * record.id（coordinator 绑定维护）优先：renderer 的 sessionRecordByIdAtomFamily
 * 只按 record.id 索引会话；tab.sessionId 是 pi 侧会话 id（两套体系），仅作兜底。
 */
export function resolveNotificationSessionId(
	resolveRecordId: (() => string | undefined) | undefined,
	piSessionId: string | undefined,
): string | undefined {
	return resolveRecordId?.() ?? piSessionId;
}

/**
 * 按对话轮次截断历史消息：找到最后 maxTurns 个 turn 起点，
 * 保留对应轮次及之后的全部消息，避免大会话加载时一次性解析过多内容。
 * 返回保留段的起始下标（无 user 消息时与 slice(-50) 语义一致）。
 *
 * turn 起点与 findTurnPageStart 同一约定（发言权周期）：
 * role==="user" 且跳过中间的杂项消息后前一条真实消息不是 user。
 * 连发 user（无 assistant 回复）只算第一条为起点，其余并入同一轮。
 */
export function turnTrimStartIndex<T>(rawMessages: T[], maxTurns = 12): number {
	if (rawMessages.length === 0) return 0;
	// 预扫描 turn 起点（与 findTurnPageStart 同一规则，O(n)）
	const turnStarts: number[] = [];
	let prevUserOrAssistantRole: "user" | "assistant" | undefined;
	for (let i = 0; i < rawMessages.length; i += 1) {
		const role = (rawMessages[i] as { role?: unknown } | undefined)?.role;
		if (role === "user") {
			if (prevUserOrAssistantRole !== "user") turnStarts.push(i);
			prevUserOrAssistantRole = "user";
		} else if (role === "assistant") {
			prevUserOrAssistantRole = "assistant";
		}
		// system/error/toolResult 等其他 role：不改变边界。
	}
	if (turnStarts.length === 0) return Math.max(0, rawMessages.length - 50);
	// 保留尾部 maxTurns 轮：起点 = 倒数第 maxTurns 个 turn 起点
	return turnStarts[Math.max(0, turnStarts.length - maxTurns)];
}

export function trimHistoryMessages<T>(rawMessages: T[], maxTurns = 12): T[] {
	if (rawMessages.length === 0) return rawMessages;
	return rawMessages.slice(turnTrimStartIndex(rawMessages, maxTurns));
}

/**
 * 统计 [0, endIndex) 内会消费 entryId 槽位的角色消息数（user/assistant/toolResult）。
 * 与 AgentMessageProjector 的槽位消费规则一致：compactionSummary/branchSummary/非角色条目
 * 不消费槽位。用于 trim 后把 activeEntryIds 与保留消息重新对齐。
 */
export function countRoleMessagesBefore<T>(rawMessages: T[], endIndex: number): number {
	const bound = Math.min(Math.max(0, endIndex), rawMessages.length);
	let count = 0;
	for (let i = 0; i < bound; i++) {
		const role = (rawMessages[i] as { role?: unknown } | undefined)?.role;
		if (role === "user" || role === "assistant" || role === "toolResult") count++;
	}
	return count;
}

/**
 * 取窗口前的系统摘要卡片（compaction/branchSummary），用于 prepend 到显示窗口最前。
 * 压缩卡片插在消息数组最前（index 0），激活分页窗口从尾部数轮次——若窗口起点 > 0，
 * 卡片会被 slice 切出窗口导致用户看不到；这里把窗口前仍存在的系统卡片找回，
 * 保证压缩标记在时间线可见区顶部（"压缩展示在正确的时间位"）。
 */
export function leadingSummaryCards(
	all: ChatMessage[],
	windowStart: number,
): ChatMessage[] {
	if (windowStart <= 0) return [];
	const cards: ChatMessage[] = [];
	const bound = Math.min(windowStart, all.length);
	for (let i = 0; i < bound; i++) {
		const message = all[i];
		if (
			message.role === "system" &&
			(message.meta?.type === "compaction" || message.meta?.type === "branchSummary")
		) {
			cards.push(message);
		}
	}
	return cards;
}

/**
 * 构造 agents:message 事件的 payload（增量 flush 协议，2026-08 渲染卡顿优化）。
 *
 * 背景：流式期间主进程每 50ms flush 一次，此前每次都发送全量消息数组——
 * 几百条消息的结构化克隆每 50ms 在渲染主线程反序列化一次，是流式卡顿主因。
 *
 * 协议：调用方显式标记 dirtyFrom（自上次 flush 以来最早的变化下标）时，
 * 只发送尾部切片 + upsertFrom + totalLength；渲染层按「从 upsertFrom 起替换尾部」合并，
 * 长度不连续则丢弃并等待下一次全量校准（终态 flush 永远全量，见 flushMessageEmit）。
 * dirtyFrom 缺失或越界（编辑/删除/截断/重载等未标记路径）一律回退全量。
 */
export function buildMessageFlushPayload(
	agentId: string,
	all: ChatMessage[],
	dirtyFrom: number | undefined,
	windowStart = 0,
	fileVersion?: string,
	windowStartFilePos?: number,
): {
	agentId: string;
	messages: ChatMessage[];
	upsertFrom?: number;
	totalLength?: number;
	windowStart?: number;
	fileVersion?: string;
	windowStartFilePos?: number;
	/** trim 窗口右移滑出显示区的旧窗口头部轮次（仅全量 flush 携带，渲染层并入历史前缀） */
	slideOut?: ChatMessage[];
} {
	// 激活显示窗口（2026-08 激活分页）：full 快照也只发窗口段 [windowStart..]，
	// 窗口前历史由 disk 轮次分页按需 prepend；totalLength 恒为数组全长，
	// 供渲染层做窗口偏移校验。fileVersion（会话文件 mtime:size）用于检测压缩改写：
	// 版本变化时渲染层丢弃 disk 前缀（其绝对下标空间已失效）。
	const boundedWindow = Math.min(Math.max(0, windowStart), all.length);
	if (dirtyFrom !== undefined && dirtyFrom >= boundedWindow && dirtyFrom < all.length) {
		return {
			agentId,
			messages: stripToolResultForDelivery(all.slice(dirtyFrom)),
			upsertFrom: dirtyFrom,
			totalLength: all.length,
			...(boundedWindow > 0 ? { windowStart: boundedWindow } : {}),
			...(fileVersion ? { fileVersion } : {}),
		};
	}
	// dirtyFrom 缺失或落到窗口之前（重载后窗口右移）：升级为窗口化全量
	// 窗口前若存在系统摘要卡片（压缩/分支），一并 prepend——压缩卡片插在数组最前，
	// 不 prepend 会被窗口 slice 切掉（增量分支不 prepend：卡片不在增量区，渲染层已有）。
	// windowStartFilePos：窗口首条消息在会话文件消息下标空间中的位置，
	// 供渲染层在窗口消息缺 entryId 时作为首次补历史的数值游标（主进程缓存/文件路径都能消费）。
	const summaryCards = leadingSummaryCards(all, boundedWindow);
	return {
		agentId,
		messages: [...summaryCards, ...stripToolResultForDelivery(all.slice(boundedWindow))],
		totalLength: all.length,
		...(boundedWindow > 0 ? { windowStart: boundedWindow } : {}),
		...(fileVersion ? { fileVersion } : {}),
		...(typeof windowStartFilePos === "number" && windowStartFilePos >= 0
			? { windowStartFilePos }
			: {}),
	};
}

/**
 * 下发瘦身：工具消息的 meta.result 与 meta.detailText 内容重复（detailText 已含截断后的
 * result 段），渲染层从不读取 result（getToolExitCode 期望对象而主进程存的是截断字符串，
 * 已确认是死代码）。剥离 result 只影响下发载荷——主进程内存仍保留（tool_execution_update
 * 无 result 时回退 existing.meta.result）。渲染层需要完整输出时走 sessionsCatalogReadMessageFullText。
 */
export function stripToolResultForDelivery(messages: ChatMessage[]): ChatMessage[] {
	let stripped = false;
	const out = messages.map((message) => {
		if (message.role !== "tool" || !message.meta || typeof message.meta.result === "undefined") {
			return message;
		}
		stripped = true;
		const meta = { ...message.meta };
		delete meta.result;
		return { ...message, meta };
	});
	return stripped ? out : messages;
}

/** 清洗会话标题文本；存储层不截断，侧栏负责视觉宽度钳制与 hover 展示。 */
export function cleanTitle(value?: string): string | undefined {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return undefined;
	return text;
}

/** 从消息列表推断会话标题（取首条 user 或 assistant 消息的清洗后文本）。 */
export function inferTitleFromMessages(messages: ChatMessage[]): string | undefined {
	const firstUserText = messages.find((message) => message.role === "user")?.text;
	const firstAssistantText = messages.find(
		(message) => message.role === "assistant",
	)?.text;
	return cleanTitle(firstUserText) || cleanTitle(firstAssistantText);
}

/** 判断 Agent 标题是否为默认/占位标题（仅此时允许首轮回话自动改名）。
 *  必须覆盖 catalog 草稿名（session.newTitle：「新会话」/「New session」）和 DSH 占位名，
 *  不能只认 `${project} agent`——漏判则 refreshAutoTitle 直接 return，侧栏一直停在占位名。
 *  pi 文件名时间戳 / catalog 清掉时间戳后的 Untitled 也算占位，否则历史会话加载后无法用首条消息补名。 */
export function isDefaultAgentTitle(
	title: string,
	project: Project,
	translate: (key: string, params?: Record<string, string | number>) => string,
): boolean {
	const trimmed = title.replace(/\s+/g, " ").trim();
	if (!trimmed) return true;
	if (looksLikePiSessionFileStem(trimmed)) return true;
	// catalog 把时间戳标题写成 Untitled；扫描器默认文案也是 Untitled。
	if (/^untitled(?: session)?$/i.test(trimmed)) return true;
	return (
		trimmed === `${project.name} agent` ||
		trimmed === `${project.name} DSH` ||
		trimmed === translate("session.newTitle") ||
		trimmed === translate("session.dshUntitled") ||
		trimmed === translate("session.untitled") ||
		trimmed === translate("session.historyTitle", { project: project.name }) ||
		trimmed === translate("session.historyFallbackTitle") ||
		trimmed === `${project.name} 历史会话` ||
		trimmed === "历史会话" ||
		trimmed === "新会话" ||
		trimmed === "New session"
	);
}
