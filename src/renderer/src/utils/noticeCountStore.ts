/**
 * 活跃 toast 集合（Notification Stack 收纳条的数据源，纯模块，可单测）。
 *
 * 背景：sonner 只堆叠展示最近 VISIBLE_TOAST_COUNT 条，被压到堆叠里的旧 toast
 * 用户看不到也滚不到（洪峰场景：Git 批量操作、长任务连发 error）。
 * 收纳条据此计算「还有 N 条未展示」，点击打开既有通知历史面板回看。
 *
 * 用 id 集合而非 +1/-1 计数器：同 id 顶掉（showNotice 的稳定 id 去重语义）时
 * sonner 走「合并更新」而非删除重建，旧 onDismiss 闭包仍会按同一 id 触发，
 * Set 天然幂等，重复加/减都不会把计数漂移成负数或虚高。
 * 集合由 utils/notice.ts 单点维护（showNotice add，onDismiss/兜底关闭 remove），
 * 调用方零改动。
 */

/** 同一时刻最多可见、且能被用户直接看见的 toast 条数（超出部分沉入堆叠）。 */
export const VISIBLE_TOAST_COUNT = 4;

const activeIds = new Set<string>();
const listeners = new Set<() => void>();

function publish() {
	for (const listener of listeners) listener();
}

export function addActiveNotice(id: string | number): void {
	// 同 id 再弹（去重顶掉）不改集合 ⇒ 不 publish，否则收纳条会因空更新重渲染
	if (activeIds.has(String(id))) return;
	activeIds.add(String(id));
	publish();
}

export function removeActiveNotice(id: string | number): void {
	if (!activeIds.delete(String(id))) return;
	publish();
}

export function getActiveNoticeCount(): number {
	return activeIds.size;
}

/** 被堆叠遮住的 toast 条数（收纳条只在 >0 时出现）。 */
export function getActiveNoticeOverflow(): number {
	return Math.max(0, activeIds.size - VISIBLE_TOAST_COUNT);
}

export function subscribeActiveNoticeCount(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
