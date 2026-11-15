/**
 * push/pull 角标（ahead/behind）的读取与刷新（从 `GitPanel.tsx` 原样搬出）。
 *
 * 角标完全由本地 refs 决定（`HEAD...@{u}`）：AI 在终端里 commit / push / 切分支后立即
 * 重读就能归零，不需要等一轮 fetch。fetch 只用来校正 behind，且要 sync + autoFetch 双闸。
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { GitAheadBehind } from "../../../../../shared/types";
import { deepEqual } from "../../../utils/deepEqual";
import type { GitPanelProps } from "../GitPanel";
import { writeAheadBehindCache } from "./gitPanelStorage";

export function useGitStatusRefresh(input: {
	props: GitPanelProps;
	repoScopeKey: string;
	gitCapabilitiesRef: MutableRefObject<{ sync: boolean; autoFetch: boolean }>;
	fetchRef: MutableRefObject<GitPanelProps["fetch"]>;
	aheadBehindRef: MutableRefObject<GitPanelProps["aheadBehind"]>;
	aheadBehindInFlightRef: MutableRefObject<Promise<void> | null>;
	aheadBehindPersistedRef: MutableRefObject<{ key: string; value: GitAheadBehind | null } | null>;
	projectIdRef: MutableRefObject<string>;
	repoScopeKeyRef: MutableRefObject<string>;
	setAheadBehind: Dispatch<SetStateAction<GitAheadBehind | null>>;
}) {
	const { props, repoScopeKey, gitCapabilitiesRef, fetchRef, aheadBehindRef, aheadBehindInFlightRef, aheadBehindPersistedRef, projectIdRef, repoScopeKeyRef, setAheadBehind } = input;

	/**
	 * 读取 push/pull 角标：只读本地 refs，不 fetch、不走网络。
	 *
	 * 为什么单独拆出一支：`HEAD...@{u}` 的差距完全由本地 refs 决定——AI 在终端里
	 * commit / push / 切分支后本地 refs 立即更新，直接重读就能把角标归零。
	 * 若只在 fetch 成功后才计数，fetch 慢或失败（离线/需凭据）时角标会长时间停在旧值
	 * （历史缺陷：AI 推完要等到下一轮 5 分钟 fetch 才消失）。
	 *
	 * aheadBehind 经 ref 读取：宿主包装器可能随外层 render 重建，不应因此重排定时器。
	 */
	const readAheadBehind = useCallback(async () => {
		const aheadBehind = aheadBehindRef.current;
		if (!aheadBehind) return;
		// 等前一个读落地再读：既怕子进程堆积，也要保证本调用拿到的是 fetch 之后的 refs。
		const inFlight = aheadBehindInFlightRef.current;
		if (inFlight) await inFlight;
		const projectId = props.projectId;
		const currentRepoScopeKey = repoScopeKey;
		const task = (async () => {
			try {
				const result = await aheadBehind(projectId);
				if (projectId !== projectIdRef.current || currentRepoScopeKey !== repoScopeKeyRef.current) return;
				// 数值没变就保留原对象：GitAheadBehind 每次都是新引用，直接 set 等于每 5 秒
				// 白重渲染一次整个面板（含变更树 / 图谱子树）。
				setAheadBehind((current) => (deepEqual(current, result) ? current : result));
				const scopeKey = `${projectId}::${currentRepoScopeKey}`;
				const persisted = aheadBehindPersistedRef.current;
				if (persisted?.key === scopeKey && deepEqual(persisted.value, result)) return;
				// 写缓存：重挂/切 tab 回来能秒显上次角标；null（无上游）时清缓存
				writeAheadBehindCache(projectId, currentRepoScopeKey, result);
				aheadBehindPersistedRef.current = { key: scopeKey, value: result };
			} catch {
				// 静默失败：非仓库/无上游时角标保持上次已知值，不弹错误
			}
		})();
		aheadBehindInFlightRef.current = task;
		try {
			await task;
		} finally {
			// 只清自己这一次：等待中的后来者会在它后面重新登记
			if (aheadBehindInFlightRef.current === task) aheadBehindInFlightRef.current = null;
		}
	}, [props.projectId, repoScopeKey]);

	/**
	 * 刷新 push/pull 角标。
	 *
	 * @param fetchRemote - 是否先 `git fetch` 再计数：
	 *   true  → 手动刷新与 5 分钟定时器（要知道别人推到远程的新提交，behind 才准）；
	 *   false → 本地事件驱动（外部 commit/push/切分支、窗口重新聚焦），只读本地 refs。
	 *
	 * 顺序刻意是「先本地 → 再 fetch → 再本地」：第一步不依赖网络，用户点刷新或 AI
	 * 在终端 push 完后角标能立即变；fetch 仅用于校正 behind，失败也不阻挡本地计数。
	 */
	const refreshAheadBehind = useCallback(
		async (fetchRemote = true) => {
			await readAheadBehind();
			if (!fetchRemote) return;
			// 刷新手势不是「显式同步」：除了 sync，还必须显式允许自动联网（autoFetch）。
			// 远端 provider 的 autoFetch 恒 false —— 透传远端能力后，刷新绝不能变成自动 fetch。
			if (!gitCapabilitiesRef.current.sync || !gitCapabilitiesRef.current.autoFetch) return;
			const fetch = fetchRef.current;
			if (!fetch) return;
			try {
				await fetch(props.projectId);
			} catch {
				// 静默失败：离线/无远程时保留上一次 fetch 的 behind，ahead 已由本地计数更新
				return;
			}
			await readAheadBehind();
		},
		[props.projectId, readAheadBehind],
	);

	return { readAheadBehind, refreshAheadBehind };
}
