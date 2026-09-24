import { atom, useAtomValue, useSetAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { useCallback, useMemo } from "react";
import { processGroupOpenBySessionIdAtomFamily, type ProcessGroupOpenState } from "../../../atoms/session-atoms";

/**
 * 过程组（一轮里连续的思考 / 工具调用块）开合状态的**状态机**（契约 §3 冻结接口）。
 *
 * 状态形状 `ProcessGroupOpenState` 定义在 `atoms/session-atoms.ts`（atom 拥有该值，依赖方向 atoms ← hook），
 * 本模块只负责状态转移与 React 接线，并把它重新导出，消费方 import 路径不变。
 *
 * 两条互不干扰的通道：
 * - `autoGroupId`：自动通道，只有一个槽位，永远指向「最新的过程组」。新组出现时推进，
 *   旧自动组因此自动关闭；
 * - `manualGroupIds`：手动通道，是用户亲手点开的组集合，新内容不影响它们。
 *
 * 组件只在 `isGroupOpen` 为 true 时渲染组体，所以「关闭」= 两个通道都不再命中该组。
 */
export type { ProcessGroupOpenState };

/**
 * 空状态常量（冻结）。
 *
 * 跨渲染保持同一引用是刻意的：selectAtom / React memo 用 Object.is 短路，
 * 「没有任何组打开」时必须返回同一个对象，否则每次派生都算新值 → 无谓重渲染。
 */
export const EMPTY_PROCESS_GROUP_STATE: ProcessGroupOpenState = Object.freeze({
	autoGroupId: undefined,
	manualGroupIds: Object.freeze([]),
	suppressedAutoGroupId: undefined,
});

/** 组是否打开：命中任一通道即为打开。 */
export function isGroupOpen(state: ProcessGroupOpenState, groupId: string): boolean {
	return state.autoGroupId === groupId || state.manualGroupIds.includes(groupId);
}

/**
 * 最新组变化时推进自动槽（同值返回原引用，便于 memo）。
 *
 * 自动槽只有一个槽位，被它指向的组就是「自动展开的组」；推进到新组后，上一个自动组
 * 不再被任何通道命中 → 随之自动关闭。手动集合原样带过：新内容不影响用户亲手打开的组。
 *
 * **抑制位**：若最新组正是用户主动点关过的那个（`suppressedAutoGroupId`），保持原样——
 * 「用户说要关着」优先于「自动展开最新组」。推进到别的组时抑制位一并清掉。
 */
export function advanceAutoGroup(state: ProcessGroupOpenState, latestGroupId: string | undefined): ProcessGroupOpenState {
	// 目标自动槽：最新组；但若它正是用户主动点关过的那个，就不要自动展开（抑制位继续保留）。
	const suppressed = latestGroupId !== undefined && state.suppressedAutoGroupId === latestGroupId;
	const nextAutoGroupId = suppressed ? undefined : latestGroupId;
	const nextSuppressedAutoGroupId = suppressed ? state.suppressedAutoGroupId : undefined;
	// 两个字段都没变 → 原引用（调用方的 setMap 因此不写 atom、不通知订阅者）。
	if (state.autoGroupId === nextAutoGroupId && state.suppressedAutoGroupId === nextSuppressedAutoGroupId) return state;
	return { autoGroupId: nextAutoGroupId, manualGroupIds: state.manualGroupIds, suppressedAutoGroupId: nextSuppressedAutoGroupId };
}

/**
 * 用户点击组头。
 *
 * - `open=true`：加入手动集合（幂等），并清空「正占着该组」的自动槽——用户已亲手接手，
 *   自动槽不该继续替它保开；
 * - `open=false`：从手动集合移除；若该组正占着自动槽也一并清空——否则自动槽仍然命中它，
 *   表现为「点关了却关不上 / 下次重算又弹开」。
 *
 * 两个通道都没变化时返回原引用（调用方可能把返回值直接 setAtom）。
 */
export function toggleGroupByUser(state: ProcessGroupOpenState, groupId: string, open: boolean): ProcessGroupOpenState {
	const wasManual = state.manualGroupIds.includes(groupId);
	const occupiesAuto = state.autoGroupId === groupId;
	if (open) {
		// 用户亲手打开：接管该组（若它同时占着自动槽则让出），并解除该组的抑制位——用户明确要它开着。
		if (wasManual && !occupiesAuto && state.suppressedAutoGroupId !== groupId) return state;
		return {
			autoGroupId: occupiesAuto ? undefined : state.autoGroupId,
			manualGroupIds: wasManual ? state.manualGroupIds : [...state.manualGroupIds, groupId],
			suppressedAutoGroupId: state.suppressedAutoGroupId === groupId ? undefined : state.suppressedAutoGroupId,
		};
	}
	if (!wasManual && !occupiesAuto) return state;
	return {
		autoGroupId: occupiesAuto ? undefined : state.autoGroupId,
		manualGroupIds: wasManual ? state.manualGroupIds.filter((id) => id !== groupId) : state.manualGroupIds,
		// 点关正占自动槽的组 = 明确表态「这组我就是要关着」→ 记抑制位，避免同值同步又把它弹回来。
		// 抑制位随 reset（大折叠栏关闭）一起清空，所以下次展开仍会正常自动展开最新组。
		suppressedAutoGroupId: occupiesAuto ? groupId : state.suppressedAutoGroupId,
	};
}

/**
 * 大折叠栏关闭时调用：两个通道一起清空。
 *
 * 组内卡片的展开态不需要额外代码：Radix 折叠时子树整体卸载（`children: isOpen && children`），
 * 组件内部 state 随之销毁（契约 §3）。
 */
export function resetProcessGroupState(): ProcessGroupOpenState {
	return EMPTY_PROCESS_GROUP_STATE;
}

/**
 * 无会话 / 无 runId 时的只读兜底：hooks 调用次数不能随入参变化，
 * 所以这里用模块级常量 atom 而不是条件调用 useAtomValue。
 */
const EMPTY_PROCESS_GROUP_STATE_ATOM = atom<ProcessGroupOpenState>(EMPTY_PROCESS_GROUP_STATE);

/**
 * 把 `ProcessGroupOpenState` 接到 Jotai 的窄 hook（集成层 TurnRow 用）。
 *
 * - groupState：只订阅 `processGroupOpenBySessionIdAtomFamily(sessionId)` 里本 runId 的切片，
 *   同会话其它轮次（分屏/多轮）的状态变化不会通知本组件；
 * - toggleGroup / syncLatestGroup / reset：写侧命令，useCallback 稳定引用（集成层会把它们
 *   放进 memo 组件的 props）；sessionId 或 runId 为空时退化为安全 no-op（不抛错、不写原子）。
 * - syncLatestGroup 的同值短路由**纯函数**保证：`advanceAutoGroup` 在「最新组没变」以及
 *   「最新组正是用户主动点关过的那个」两种情况下返回原引用，`setMap` 因此不写 atom、
 *   不通知订阅者。**刻意不做组件级 ref 记忆**——ref 清不掉，会让「关掉大折叠栏再展开」
 *   无法恢复自动展开（见 atoms 里 `suppressedAutoGroupId` 的说明）。
 */
export function useProcessGroupOpenState(
	sessionId: string | undefined,
	runId: string | undefined,
): {
	/** 本轮的组开合状态；未挂载/无会话时返回 EMPTY_PROCESS_GROUP_STATE */
	groupState: ProcessGroupOpenState;
	/** 用户点某个组头：走 toggleGroupByUser 并写回 atom */
	toggleGroup: (groupId: string, open: boolean) => void;
	/** 最新组变化时推进自动槽（内部做同值短路，避免无谓写 atom） */
	syncLatestGroup: (latestGroupId: string | undefined) => void;
	/** 大折叠栏关闭时调用：两通道一起清空并写回 */
	reset: () => void;
} {
	// 按 runId 取本轮的切片；Object.is 保证「本 run 无状态」时恒等于 EMPTY 常量，不触发重渲染。
	const stateAtom = useMemo(() => (sessionId ? selectAtom(processGroupOpenBySessionIdAtomFamily(sessionId), (map) => (runId ? map[runId] : undefined) ?? EMPTY_PROCESS_GROUP_STATE, Object.is) : EMPTY_PROCESS_GROUP_STATE_ATOM), [sessionId, runId]);
	const groupState = useAtomValue(stateAtom);
	// 写侧仍拿整张 map（按 sessionId 隔离）；无 sessionId 时命中的是空字符串 family 实例，
	// 但三个命令的前置守卫保证不会真的写进去。
	const setMap = useSetAtom(processGroupOpenBySessionIdAtomFamily(sessionId ?? ""));

	const toggleGroup = useCallback(
		(groupId: string, open: boolean) => {
			if (!sessionId || !runId) return;
			setMap((prev) => {
				const current = prev[runId] ?? EMPTY_PROCESS_GROUP_STATE;
				const next = toggleGroupByUser(current, groupId, open);
				// 值没变：保持 map 原引用，jotai 因此不会通知订阅者重渲染。
				if (next === current) return prev;
				return { ...prev, [runId]: next };
			});
		},
		[sessionId, runId, setMap],
	);

	const syncLatestGroup = useCallback(
		(latestGroupId: string | undefined) => {
			if (!sessionId || !runId) return;
			// 不做「已同步过就跳过」的组件级记忆：那会让「关闭大折叠栏后再展开」无法恢复自动展开
			// （reset 清的是 atom，清不掉组件 ref）。抑制语义现在由状态里的 suppressedAutoGroupId 承担，
			// 因此这里可以无条件走同一个纯函数；advanceAutoGroup 同值返回原引用 = 天然短路、不写 atom。
			setMap((prev) => {
				const current = prev[runId] ?? EMPTY_PROCESS_GROUP_STATE;
				const next = advanceAutoGroup(current, latestGroupId);
				if (next === current) return prev;
				return { ...prev, [runId]: next };
			});
		},
		[sessionId, runId, setMap],
	);

	const reset = useCallback(() => {
		if (!sessionId || !runId) return;
		setMap((prev) => {
			// 大折叠栏关闭：直接删除该轮条目（等价于空态），避免长期堆积已关闭轮次。
			if (!(runId in prev)) return prev;
			const next = { ...prev };
			delete next[runId];
			return next;
		});
	}, [sessionId, runId, setMap]);

	// 整个句柄也 memo：groupState 未变时集成层拿到的对象引用也稳定。
	return useMemo(() => ({ groupState, toggleGroup, syncLatestGroup, reset }), [groupState, toggleGroup, syncLatestGroup, reset]);
}
