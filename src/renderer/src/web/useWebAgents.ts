/**
 * Web 端智能体目录（AgentProfileStore 投影）的持有者。
 *
 * 只拉一次；弹窗每次打开再刷一次（角色设定多在桌面端改）。目录同时供
 * 「智能体」弹窗与会话页的已绑定提示条使用——两处共用一份，避免各拉一次。
 */
import { useCallback, useEffect, useState } from "react";
import { fetchAgents } from "./webApi";
import type { WebAgentsPhase } from "./WebAgentsDialog";
import type { WebAgentProfile } from "./webTypes";

export function useWebAgents(): { agents: WebAgentProfile[]; phase: WebAgentsPhase; reload: () => void } {
	const [agents, setAgents] = useState<WebAgentProfile[]>([]);
	const [phase, setPhase] = useState<WebAgentsPhase>("loading");

	const reload = useCallback(() => {
		// 已有目录时后台刷新，不把列表打回转圈（打开弹窗不该闪一下 loading）。
		setPhase((current) => (current === "ready" ? current : "loading"));
		void fetchAgents()
			.then((next) => {
				setAgents(next);
				setPhase("ready");
			})
			.catch(() => setPhase("error"));
	}, []);

	useEffect(() => reload(), [reload]);

	return { agents, phase, reload };
}
