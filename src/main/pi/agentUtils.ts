/**
 * AgentManager 纯工具函数。
 * Phase 1.3: 从 AgentManager.ts 中提取，无副作用，不依赖实例状态。
 */

import type { ChatMessage, Project } from "../../shared/types";

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
 * 按对话轮次截断历史消息：找到最后 maxTurns 个 user 提问，
 * 保留对应轮次及之后的全部消息，避免大会话加载时一次性解析过多内容。
 */
export function trimHistoryMessages(rawMessages: unknown[], maxTurns = 40): unknown[] {
	if (rawMessages.length === 0) return rawMessages;
	const userIndices: number[] = [];
	for (let i = rawMessages.length - 1; i >= 0; i--) {
		const msg = rawMessages[i] as { role?: unknown } | undefined;
		if (msg?.role === "user") {
			userIndices.unshift(i);
			if (userIndices.length >= maxTurns) break;
		}
	}
	if (userIndices.length === 0) return rawMessages.slice(-50);
	return rawMessages.slice(userIndices[0]);
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
): { agentId: string; messages: ChatMessage[]; upsertFrom?: number; totalLength?: number } {
	if (dirtyFrom !== undefined && dirtyFrom >= 0 && dirtyFrom < all.length) {
		return {
			agentId,
			messages: all.slice(dirtyFrom),
			upsertFrom: dirtyFrom,
			totalLength: all.length,
		};
	}
	return { agentId, messages: all };
}

/** 清洗会话标题文本。 */
export function cleanTitle(value?: string): string | undefined {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return undefined;
	return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

/** 从消息列表推断会话标题（取首条 user 或 assistant 消息的清洗后文本）。 */
export function inferTitleFromMessages(messages: ChatMessage[]): string | undefined {
	const firstUserText = messages.find((message) => message.role === "user")?.text;
	const firstAssistantText = messages.find(
		(message) => message.role === "assistant",
	)?.text;
	return cleanTitle(firstUserText) || cleanTitle(firstAssistantText);
}

/** 判断 Agent 标题是否为默认标题（项目名 + "agent" / "历史会话" 等变体）。 */
export function isDefaultAgentTitle(
	title: string,
	project: Project,
	translate: (key: string, params?: Record<string, string | number>) => string,
): boolean {
	return (
		title === `${project.name} agent` ||
		title === translate("session.historyTitle", { project: project.name }) ||
		title === translate("session.historyFallbackTitle") ||
		title === `${project.name} 历史会话` ||
		title === "历史会话"
	);
}
