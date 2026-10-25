import { atom } from "jotai";
import { nextSessionActivityAnchor } from "../utils/sessionActivityClock";

/**
 * 会话计时点（ms）：侧栏相对时间的基准时刻，key 是持久会话 id。
 *
 * 只在本轮开始（用户输入落地）与本轮结束（turn 结束）两个边界推进，规则见
 * `utils/sessionActivityClock.ts`；没有条目的会话回落到 catalog.updatedAt / 访问时间，
 * 因此历史会话的显示与改动前一致。只存在渲染进程内存里：重启后回到「最后一条消息」的
 * 文件时间，语义不变（也不需要为它做持久化迁移）。
 */
export const sessionActivityAnchorByIdAtom = atom<Record<string, number>>({});

/** 相对时间刷新节拍（Date.now 快照）：显示粒度最小到分钟，30s 一跳足够。 */
export const relativeTimeNowAtom = atom(0);

/** 回合边界推进计时点；没有边界（中间态、首次观测到空闲会话）时不写 atom。 */
export const advanceSessionActivityAnchorAtom = atom(null, (get, set, input: { sessionId: string; previousRunning: boolean; running: boolean; now?: number }) => {
	const anchor = nextSessionActivityAnchor({ previousRunning: input.previousRunning, running: input.running, now: input.now ?? Date.now() });
	if (anchor === undefined) return;
	set(sessionActivityAnchorByIdAtom, { ...get(sessionActivityAnchorByIdAtom), [input.sessionId]: anchor });
});

/** 会话删除/匿名会话释放时清掉计时点（与 removeSessionStateAtom 配对，避免 Map 只增不清）。 */
export const forgetSessionActivityAnchorAtom = atom(null, (get, set, sessionId: string) => {
	const anchors = get(sessionActivityAnchorByIdAtom);
	if (!(sessionId in anchors)) return;
	const next = { ...anchors };
	delete next[sessionId];
	set(sessionActivityAnchorByIdAtom, next);
});
