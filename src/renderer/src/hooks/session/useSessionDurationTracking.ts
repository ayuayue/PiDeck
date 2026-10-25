import { useEffect, useRef, useState } from "react";
import { stampIdleSessionDuration } from "../../rendererUtils";
import type { AgentTab } from "../../../../shared/types";

export interface SessionDurationTrackingDeps {
	displayAgents: AgentTab[];
	activeAgentId: string | undefined;
}

/**
 * 会话时长跟踪域：记录每个 agent 的会话开始时间（status 变为 running），
 * 在 running→idle 边沿写总时长（sessionDurationByAgent），供 Tab 徽章/时间线展示。
 * - 全部经 ref 镜像读写，effect 闭包不持有旧渲染帧；
 * - agent 标签关闭后旧键按活集合裁剪（agentId 每次 spawn 随机，不裁会永久残留）；
 * - 只在边沿写：已 idle 后再被新 displayAgents 引用戳到不得 setState。
 */
export function useSessionDurationTracking({ displayAgents, activeAgentId }: SessionDurationTrackingDeps) {
	/** 每个 agent 最后一次会话的开始时间(status 变为 running 时记录),用 ref 避免 effect 闭包陈旧 */
	const sessionStartByAgentRef = useRef<Record<string, number>>({});
	/** 每个 agent 最后一次会话的总时长(ms),仅在会话结束后更新 */
	const [sessionDurationByAgent, setSessionDurationByAgent] = useState<Record<string, number>>({});
	const agentStatusByAgentRef = useRef<Record<string, AgentTab["status"]>>({});

	useEffect(() => {
		// 活 agent 集合（agentId 每次 spawn 随机，标签关闭后旧键永久残留 → 按活集合裁剪，2026-10）
		const liveIds = new Set(displayAgents.map((a) => a.id));
		for (const id of Object.keys(agentStatusByAgentRef.current)) {
			if (!liveIds.has(id)) delete agentStatusByAgentRef.current[id];
		}
		for (const id of Object.keys(sessionStartByAgentRef.current)) {
			if (!liveIds.has(id)) delete sessionStartByAgentRef.current[id];
		}
		setSessionDurationByAgent((d) => {
			let changed = false;
			const next: typeof d = {};
			for (const id of Object.keys(d)) {
				if (liveIds.has(id)) next[id] = d[id];
				else changed = true;
			}
			return changed ? next : d;
		});
		for (const agent of displayAgents) {
			if (agent.id !== activeAgentId) continue;
			const previousStatus = agentStatusByAgentRef.current[agent.id];
			const stamped = stampIdleSessionDuration({
				previousStatus,
				status: agent.status,
				startedAt: sessionStartByAgentRef.current[agent.id],
				now: Date.now(),
			});
			// 只在 running→idle 边沿写时长；已 idle 后再被新 displayAgents 引用戳到不得 setState。
			if (stamped.clearStart) {
				delete sessionStartByAgentRef.current[agent.id];
			} else if (stamped.startedAt != null) {
				sessionStartByAgentRef.current[agent.id] = stamped.startedAt;
			}
			if (stamped.durationMs != null) {
				const durationMs = stamped.durationMs;
				setSessionDurationByAgent((d) => (d[agent.id] === durationMs ? d : { ...d, [agent.id]: durationMs }));
			}
			agentStatusByAgentRef.current[agent.id] = agent.status;
		}
	}, [activeAgentId, displayAgents]);

	return { sessionDurationByAgent };
}
