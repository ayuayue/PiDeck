import type { SessionSortModeId, SessionSummary } from "../../shared/types/session";
import type { TranslationKey } from "./i18n/rendererCopy.zh-CN";
import { DEFAULT_SESSION_SORT_MODE } from "../../shared/sessionSort";

/**
 * 项目会话排序策略目录（2027-03 开放排序规则）。
 *
 * 「扩展」方式：往 SESSION_SORT_MODES 注册一项（id 必须先加进 shared 的
 * SessionSortModeId 联合类型，主进程只存字符串不参与解释）。UI 的排序菜单
 * 从本目录渲染选项，不逐项硬编码；策略保持纯函数，compareProjectChildren
 * 统一消费，侧栏/搜索/嵌套 worktree 自然一致。
 */
export type SessionSortModeOption = {
	id: SessionSortModeId;
	/** 菜单文案 i18n key（rendererCopy 三语同步，类型取 zh-CN 为基准的联合） */
	labelKey: TranslationKey;
};

export const SESSION_SORT_MODES: readonly SessionSortModeOption[] = [
	{ id: "updatedAt", labelKey: "app.sessionSortMode.updatedAt" },
	{ id: "createdAt", labelKey: "app.sessionSortMode.createdAt" },
	{ id: "title", labelKey: "app.sessionSortMode.title" },
];

/** 未知值（手改 settings/未来删除的方案）回落默认「最近活跃」。 */
export function resolveSessionSortMode(value: unknown): SessionSortModeId {
	return value === "createdAt" || value === "title" ? value : DEFAULT_SESSION_SORT_MODE;
}

/**
 * 会话对（无 agent 行包装）的排序：draft 区块与纯会话列表复用，与
 * compareProjectChildren 同一语义（createdAt 缺省回退 updatedAt；标题字典序同名回退时间）。
 * 输入取结构化子集：SessionSummary 与 catalog SessionRecord（draft 行标题在 title 字段）都能直接传入。
 */
export type SessionSortInput = Pick<SessionSummary, "updatedAt"> & { name?: string; title?: string; preview?: string; createdAt?: number };

export function compareSessionsForSortMode(left: SessionSortInput, right: SessionSortInput, sortMode: SessionSortModeId = DEFAULT_SESSION_SORT_MODE): number {
	const titleOf = (session: SessionSortInput) => session.name ?? session.title ?? session.preview ?? "";
	if (sortMode === "createdAt") {
		const byCreated = (right.createdAt ?? right.updatedAt) - (left.createdAt ?? left.updatedAt);
		return byCreated !== 0 ? byCreated : right.updatedAt - left.updatedAt;
	}
	if (sortMode === "title") {
		const byTitle = titleOf(left).localeCompare(titleOf(right), undefined, { numeric: true, sensitivity: "base" });
		return byTitle !== 0 ? byTitle : right.updatedAt - left.updatedAt;
	}
	return right.updatedAt - left.updatedAt;
}
