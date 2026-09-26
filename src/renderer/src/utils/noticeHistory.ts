/**
 * toast 通知历史：renderer 进程级环形缓冲（纯模块，无 React/sonner 依赖，可单测）。
 *
 * 背景：扩展 ctx.ui.notify 等来源的 toast 停留时间短、发得频繁，用户错过后无从回看。
 * showNotice 是全渲染层唯一入口，因此在其内部单点记录，调用方零改动。
 *
 * 边界：
 * - 只存内存（会话级），重启清空、不落盘——历史记录可能含会话内容，落盘等于新开一条持久化链路；
 * - 条数封顶 NOTICE_HISTORY_MAX_ENTRIES，超出丢最旧；
 * - 不记录 action 按钮回调（重放由消费方重新发起），也不做 dedup——每次弹出都是一条事实。
 */
import type { NoticeKind } from "./notice";

/** 展示档位：NoticeKind + 无 kind 调用共用的 neutral 档（与 NoticeToastCard 图标语义一致）。 */
export type NoticeHistoryKind = NoticeKind | "neutral";

export type NoticeHistoryEntry = {
	/** 模块自增 id（React list key） */
	id: number;
	/** 弹出时间戳（ms） */
	timestamp: number;
	kind: NoticeHistoryKind;
	/** 主文案（卡片标题位） */
	title: string;
	/** 描述（长文本详情弹窗展示的部分） */
	description?: string;
	/** 生效时长（ms）；Number.POSITIVE_INFINITY = 常驻不自动消失 */
	duration: number;
};

/** 环形缓冲上限：够覆盖一次长调试会话的刷屏量，又不至于无界涨内存。 */
export const NOTICE_HISTORY_MAX_ENTRIES = 200;

let nextId = 1;
let entries: NoticeHistoryEntry[] = [];
const listeners = new Set<() => void>();

/** useSyncExternalStore 快照：缓存引用，保证未变更时恒等。 */
let snapshot: readonly NoticeHistoryEntry[] = Object.freeze([]);
function publish() {
	snapshot = Object.freeze(entries.slice());
	for (const listener of listeners) listener();
}

/** 记录一次弹出（由 showNotice 调用）。 */
export function recordNoticeHistory(input: { title: string; description?: string; kind: NoticeHistoryKind; duration: number }): void {
	entries.push({ id: nextId++, timestamp: Date.now(), ...input });
	if (entries.length > NOTICE_HISTORY_MAX_ENTRIES) entries = entries.slice(entries.length - NOTICE_HISTORY_MAX_ENTRIES);
	publish();
}

export function getNoticeHistorySnapshot(): readonly NoticeHistoryEntry[] {
	return snapshot;
}

export function subscribeNoticeHistory(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 历史表格的筛选条件（纯内存过滤，配合 Pagination 做客户端分页）。 */
export type NoticeHistoryFilter = {
	/** 关键词，命中标题或详情即保留；忽略大小写与首尾空白 */
	search: string;
	kind: NoticeHistoryKind | "all";
};

/**
 * 表格数据源：最新在前 + 按档位/关键词筛选。
 * 独立成纯函数是为了能被单测直接断言（弹窗本体依赖 Radix，不适合跑 node --test）。
 */
export function filterNoticeHistory(entries: readonly NoticeHistoryEntry[], filter: NoticeHistoryFilter): NoticeHistoryEntry[] {
	const keyword = filter.search.trim().toLowerCase();
	const result: NoticeHistoryEntry[] = [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (filter.kind !== "all" && entry.kind !== filter.kind) continue;
		if (keyword && !`${entry.title}\n${entry.description ?? ""}`.toLowerCase().includes(keyword)) continue;
		result.push(entry);
	}
	return result;
}

/** 清空历史（只清记录，不影响正在展示的 toast）。 */
export function clearNoticeHistory(): void {
	entries = [];
	publish();
}
