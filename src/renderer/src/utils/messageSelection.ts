/**
 * 多选消息树的选择逻辑（纯函数，可单测）。
 *
 * 口径约定（与导出一致）：可选项 = user 消息 + agent-run 内的 assistant 文本消息；
 * 勾选集即导出集。工具/思考消息只读展示、不参与选择，避免「勾了却导不出」的歧义。
 * 零运行时依赖（仅 import type），便于 tests/*.test.mjs 直接 transpile 验证。
 */
import type { AgentRunItem, RenderMessage } from "../components/app/AppUtils";

/** 收集全部可勾选消息 id：顶层 user/assistant 消息 + run 内 assistant 消息。 */
export function getSelectableMessageIds(items: RenderMessage[]): string[] {
	const ids: string[] = [];
	for (const item of items) {
		if (item.kind === "message") {
			if (item.message.role === "user" || item.message.role === "assistant") {
				ids.push(item.message.id);
			}
		} else if (item.kind === "agent-run") {
			ids.push(...getRunAssistantIds(item));
		}
	}
	return ids;
}

/** run 内可勾选的 assistant 消息 id（按出现顺序）。 */
export function getRunAssistantIds(run: AgentRunItem): string[] {
	const ids: string[] = [];
	for (const sub of run.items) {
		if (sub.kind === "message" && sub.message.role === "assistant") {
			ids.push(sub.message.id);
		}
	}
	return ids;
}

/** 切换单条消息的勾选态，返回新集合（不可变风格）。 */
export function toggleMessage(selectedIds: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(selectedIds);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

/** 整组切换一个 run：全部已选则清空，否则全选。 */
export function toggleRun(selectedIds: ReadonlySet<string>, run: AgentRunItem): Set<string> {
	const ids = getRunAssistantIds(run);
	if (ids.length === 0) return new Set(selectedIds);
	const allSelected = ids.every((id) => selectedIds.has(id));
	const next = new Set(selectedIds);
	for (const id of ids) {
		if (allSelected) next.delete(id);
		else next.add(id);
	}
	return next;
}

/** run 头部三态：全选 / 部分选中 / 未选。 */
export type RunSelectionState = "checked" | "indeterminate" | "unchecked";

export function getRunSelectionState(selectedIds: ReadonlySet<string>, run: AgentRunItem): RunSelectionState {
	const ids = getRunAssistantIds(run);
	if (ids.length === 0) return "unchecked";
	const selectedCount = ids.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0);
	if (selectedCount === 0) return "unchecked";
	return selectedCount === ids.length ? "checked" : "indeterminate";
}

/** 全选/清空：selectedIds.size === allIds.length 时清空，否则全选。 */
export function toggleAll(selectedIds: ReadonlySet<string>, allIds: ReadonlyArray<string>): Set<string> {
	if (allIds.length > 0 && selectedIds.size === allIds.length) {
		return new Set();
	}
	return new Set(allIds);
}

export type ToolSummary = { name: string; count: number };

/**
 * run 内工具调用摘要（只读展示用）：按工具名聚合次数。
 * 只统计 tool-group 里的 tool 消息；工具名口径与 TimelineFormat.getToolName 一致。
 */
export function getToolSummaries(run: AgentRunItem): ToolSummary[] {
	const counts = new Map<string, number>();
	for (const sub of run.items) {
		if (sub.kind !== "tool-group") continue;
		for (const message of sub.messages) {
			if (message.role !== "tool") continue;
			const name = extractToolName(message);
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	return Array.from(counts, ([name, count]) => ({ name, count }));
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const LEADING_STATUS_RE = /^[\u25b6\u2713\u2717]\s*/u;

/**
 * 提取工具显示名：meta.toolName 优先；
 * 回退剥 ANSI 与行首状态符号（▶/✓/✗）后的文本首词。
 */
export function extractToolName(message: { meta?: unknown; text: string }): string {
	const meta = message.meta as { toolName?: unknown } | undefined;
	if (typeof meta?.toolName === "string" && meta.toolName.trim()) {
		return meta.toolName;
	}
	const cleaned = message.text.replace(ANSI_ESCAPE_RE, "").replace(LEADING_STATUS_RE, "").trim();
	return cleaned.split(/\s+/)[0] || "tool";
}
