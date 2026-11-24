/**
 * 目录对账：目录里已不存在的会话，运行态该不该留。
 *
 * 背景（用户反馈的「删不掉的幽灵行」）：删掉父会话后，它开出的关联子会话「自己并列在左侧」，
 * 右键删除毫无反应、「关闭 Agent」只回「会话已不存在，请刷新会话列表」，刷新也消不掉。
 *
 * 幽灵行的判据是「运行时还在、catalog 记录已无」：
 * - 删除项按 `sessionsByProject` 解析记录 → 查不到 → 整段静默跳过（点了没反应）；
 * - 关闭 Agent → `resolveStopTarget` → `catalog.get` 为空 → SESSION_NOT_FOUND（让用户刷新）；
 * - 目录刷新只重拉记录、不碰运行时表 → 永远清不掉。
 *
 * 正常路径由主进程推 detach（删除 / 终端惰性解绑）先收敛；这里是兜底，让「刷新」也能修好，
 * 覆盖 detach 在渲染层重载或异常路径上丢失的情形。
 *
 * 独立模块而不是塞进 `session-atoms.ts`（存量巨文件只准降）：判据是纯函数可单测，
 * 写入也在这里自成一个写 atom，调用方只需 `set(dropSessionRuntimesAtom, ids)`。
 */
import { atom } from "jotai";
import { sessionRuntimeByIdAtom, sessionRuntimeUiByIdAtom } from "./session-atoms";

export type VanishedRuntimePruneInput = {
	/** 目录重拉后消失的会话 id（上一轮有、本轮无）。 */
	vanishedSessionIds: readonly string[];
	/** 当前渲染层持有的运行时表（只读判定）。 */
	runtimes: Readonly<Record<string, unknown>>;
	/** 当前渲染层的运行时 UI 表（审批 / 提问等），有残留也要一并收掉。 */
	runtimeUi: Readonly<Record<string, unknown>>;
};

/**
 * 返回需要清掉运行态的会话 id：只挑「目录里消失、且确实还挂着运行时或运行时 UI」的那些，
 * 不动别的会话。没有可清的就返回空数组（调用方据此保持 atom 引用稳定，不触发无谓重渲）。
 */
export function vanishedRuntimeSessionIds(input: VanishedRuntimePruneInput): string[] {
	const stale: string[] = [];
	for (const sessionId of input.vanishedSessionIds) {
		if (input.runtimes[sessionId] || input.runtimeUi[sessionId]) stale.push(sessionId);
	}
	return stale;
}

/** 从一张表里删掉给定 key；没有变化时返回原引用（jotai 用 Object.is 比较，避免无谓重渲）。 */
export function withoutSessionKeys<T>(table: Readonly<Record<string, T>>, sessionIds: readonly string[]): Readonly<Record<string, T>> {
	if (!sessionIds.some((sessionId) => sessionId in table)) return table;
	const next = { ...table };
	for (const sessionId of sessionIds) delete next[sessionId];
	return next;
}

/**
 * 丢掉这些会话的运行态与运行时 UI。用于两处：
 * - 目录对账（`useProjectSync` 每次项目会话重拉后传入消失的 id）；
 * - 会话被删除时的整条收尾（`removeSessionStateAtom` 复用同一份清理）。
 */
export const dropSessionRuntimesAtom = atom(null, (get, set, sessionIds: readonly string[]) => {
	const runtimes = get(sessionRuntimeByIdAtom);
	const runtimeUi = get(sessionRuntimeUiByIdAtom);
	const stale = vanishedRuntimeSessionIds({ vanishedSessionIds: sessionIds, runtimes, runtimeUi });
	if (stale.length === 0) return;
	set(sessionRuntimeByIdAtom, withoutSessionKeys(runtimes, stale) as typeof runtimes);
	set(sessionRuntimeUiByIdAtom, withoutSessionKeys(runtimeUi, stale) as typeof runtimeUi);
});
