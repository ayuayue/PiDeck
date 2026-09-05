import type { ChatMessage } from "../../../../shared/types";
// 文件修改/工具名解析已迁往 shared/fileChanges（main 的 AgentManager 与渲染层共用同一份聚合口径）；
// 此处 import 供本文件保留函数使用，并 re-export 保持既有 import 路径兼容。
import {
	collectSessionFileChanges,
	getToolDiffTarget,
	getToolFilePath,
	getToolName,
	stripAnsi,
} from "../../../../shared/fileChanges.ts";
export { collectSessionFileChanges, getToolDiffTarget, getToolName, stripAnsi };
import type { AgentRunItem } from "../app/AppUtils";

/* stripThinkingTags 与 AppUtils 同逻辑的内联副本（此文件被 node 单测直接加载，改动需同步） */
export function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

export function getToolStatus(
  message: ChatMessage,
): "running" | "done" | "error" {
  const status = String(message.meta?.status ?? "");
  if (status === "running") return "running";
  if (status === "error" || message.role === "error") return "error";
  return "done";
}

/**
 * 工具运行中秒表的起点：优先取 meta.startedAt，异常/缺失回退消息 timestamp。
 *
 * 主进程契约（AgentManager.upsertToolMessage）：tool_execution_start 时写入
 * meta.startedAt 后不再变化，它是工具耗时的唯一稳定基准（结束时 durationMs
 * 也由它推导）；而 message.timestamp 会在每次 tool_execution_update / end 时
 * 被刷新（existing.timestamp = Date.now()）。若用消息时间戳做起点，长命令
 * （如 npm test 流式输出）期间秒表会被反复重置——显示老是几毫秒/零点几秒，
 * 工具结束才突然跳到总时长。DSH 投影等无 startedAt 的消息回退 timestamp
 * （其 timestamp 本身随事件固定，不会中途刷新）。
 */
export function getToolLiveStartTimestamp(message: ChatMessage): number {
  const startedAt = message.meta?.startedAt;
  return typeof startedAt === "number" && startedAt > 0
    ? startedAt
    : message.timestamp;
}

/** 从工具参数中提取文件路径（write/edit/create/patch 等文件工具） */
export function getToolArgFilePath(args: Record<string, unknown> | undefined): string | undefined {
	return getToolFilePath(args);
}

/**
 * 一轮 agent-run 内文件修改行的展示结构：
 * 与 beUI FileDiffLine 结构兼容（oldLine/newLine 可选，缺省即可直接传入 FileDiff）。
 */
export type TurnFileDiffLine = {
	id: string;
	type: "added" | "removed" | "context";
	content: string;
};

/**
 * 收集一轮 agent-run 内修改的文件：展开 run.items 的全部消息后复用
 * collectSessionFileChanges。run 完成后其内容不再变化，因此每轮底部展示天然固定，
 * 不会被后续消息清掉。
 */
export function collectRunFileChanges(
	run: AgentRunItem,
): Array<{ path: string; count: number; originalContent: string; content: string }> {
	const msgs: ChatMessage[] = [];
	for (const item of run.items) {
		if (item.kind === "message") {
			msgs.push(item.message);
		} else if (item.kind === "tool-group" || item.kind === "thinking-group") {
			msgs.push(...item.messages);
		}
	}
	return collectSessionFileChanges(msgs);
}

/**
 * 文件修改条目 → beUI FileDiff 行序列：
 * edit/patch 展示变动区域（removed 旧行 + added 新行）；
 * write/create 无旧内容，整文件视为新增（全 added）。
 */
export function fileChangeToDiffLines(entry: {
	originalContent: string;
	content: string;
}): TurnFileDiffLine[] {
	const hasOld = entry.originalContent.length > 0;
	const lines: TurnFileDiffLine[] = [];
	entry.originalContent.split("\n").forEach((content, index) => {
		if (hasOld) lines.push({ id: `removed-${index}`, type: "removed", content });
	});
	entry.content.split("\n").forEach((content, index) => {
		lines.push({ id: `added-${index}`, type: "added", content });
	});
	return lines;
}

export function getToolDetailText(message: ChatMessage): string {
  if (typeof message.meta?.detailText === "string") {
    return stripAnsi(message.meta.detailText);
  }
  return stripAnsi(JSON.stringify(message.meta ?? {}, null, 2));
}

export function getToolExitCode(message: ChatMessage): number | undefined {
  const result = message.meta?.result;
  if (!result || typeof result !== "object") return undefined;
  const value = (result as { exitCode?: unknown }).exitCode;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes}m${remaining}s` : `${minutes}m`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 上下文占用百分比展示（adaptive precision）：≥10 取整、≥1 一位小数、<1 保留两位小数。
 * 1M 上下文窗口下几百 token 的占用（≈0.04%）若按整数四舍五入会显示成「0%」，
 * 与「~408 / 1M」并列时看起来像算错了——低占用必须保留有效数字。
 */
export function formatPercent(value: number): string {
  if (value >= 10) return String(Math.round(value));
  if (value >= 1) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 100) / 100);
}
