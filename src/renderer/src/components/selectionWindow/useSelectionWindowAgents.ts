import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentMarketSettings, AgentProfile, AgentProfileSnapshot } from "../../../../shared/types/agentProfile";
import { desktopApi } from "../../desktopApi";
import { resolveDefaultSelectionAgent, sortAgentsForMarket } from "../agents/agentMarketFilters";

export type SelectionWindowAgentsState = {
	/** 市场展示顺序（内置翻译在前）的智能体列表。 */
	agents: AgentProfile[];
	/** 快照未到时为 null（默认智能体解析依赖设置）。 */
	settings: AgentMarketSettings | null;
	/** 生效默认智能体：配置值 → 内置翻译 → 列表第一个；空列表为 null。 */
	defaultAgent: AgentProfile | null;
	/** 重新拉取快照：浮窗每次弹出时调用（见下方注释）。 */
	refresh: () => void;
};

/**
 * 浮窗自己的智能体快照订阅。
 *
 * 不复用主窗口的 Jotai atom：划词浮窗是独立渲染进程（独立页面、没有 App 装配），
 * 直接在窗口内取快照并订阅 changed 事件。两个刷新时机：
 * - 挂载时拉一次；
 * - 每次弹出（捕获）时由视图调用 refresh()——主进程目前只把 agentProfilesChanged
 *   推给主窗口，浮窗收不到；窗口又是常驻复用的，不刷新就会拿着启动瞬间的旧列表
 *   （默认智能体被删除后仍按旧 id 调用，主进程只能报错）。
 * 卸载时退订 changed 监听。
 */
export function useSelectionWindowAgents(): SelectionWindowAgentsState {
	const [snapshot, setSnapshot] = useState<AgentProfileSnapshot | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	const refresh = useCallback(() => {
		setReloadToken((current) => current + 1);
	}, []);

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			void desktopApi.agentProfiles
				.getSnapshot()
				.then((next) => {
					if (!cancelled) setSnapshot(next);
				})
				.catch(() => {
					// IPC 失败（主进程重启中）保留上一次快照：浮窗仍能按旧列表工作。
				});
		};
		load();
		const unsubscribe = desktopApi.agentProfiles.onChanged(() => load());
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [reloadToken]);

	const agents = useMemo(() => (snapshot ? sortAgentsForMarket(snapshot.agents, snapshot.agentOrder) : []), [snapshot]);
	const defaultAgent = useMemo(() => (snapshot ? resolveDefaultSelectionAgent(agents, snapshot.settings) : null), [agents, snapshot]);
	return { agents, settings: snapshot?.settings ?? null, defaultAgent, refresh };
}
