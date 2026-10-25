import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { agentProfileSnapshotAtom } from "../../../atoms/agent-atoms";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import type { AgentProfile, CreateAgentProfileInput, UpdateAgentProfileInput } from "../../../../../shared/types/agentProfile";

/** 市场写操作的统一错误提示：IPC 抛出的 Error 只把 message 交给用户，其余类型兜底转字符串。 */
function reportAgentMarketError(error: unknown): void {
	showNotice(error instanceof Error ? error.message : String(error), 3500, "error");
}

export type AgentMarketActions = {
	createAgent: (input: CreateAgentProfileInput) => Promise<AgentProfile | null>;
	updateAgent: (agentId: string, patch: UpdateAgentProfileInput) => Promise<AgentProfile | null>;
	deleteAgent: (agent: AgentProfile) => Promise<boolean>;
	/** 批量删除：内置条目被过滤掉，返回实际删除条数。 */
	deleteAgents: (agents: readonly AgentProfile[]) => Promise<number>;
	duplicateAgent: (agent: AgentProfile) => Promise<AgentProfile | null>;
	resetBuiltinAgent: (agent: AgentProfile) => Promise<AgentProfile | null>;
	setSelectionDefault: (agent: AgentProfile) => Promise<boolean>;
};

/**
 * 智能体写操作收口（卡片 / 详情 / 编辑器共用）。
 *
 * 为什么每次成功后主动重拉快照：主进程的 agent-profiles:changed 事件有往返延迟，
 * 预览/Web 桩更是没有事件推送；卡片/编辑器必须立刻反映结果，否则用户会看到
 * 「保存了但列表没变」。事件到达后再刷一次是幂等的，不会闪。
 *
 * 失败一律返回 null / false 并 toast，调用方据此决定是否关闭编辑器、保留表单。
 */
export function useAgentMarketActions(): AgentMarketActions {
	const setSnapshot = useSetAtom(agentProfileSnapshotAtom);

	const refreshSnapshot = useCallback(async () => {
		try {
			setSnapshot(await desktopApi.agentProfiles.getSnapshot());
		} catch (error) {
			reportAgentMarketError(error);
		}
	}, [setSnapshot]);

	const createAgent = useCallback(
		async (input: CreateAgentProfileInput) => {
			try {
				const created = await desktopApi.agentProfiles.create(input);
				await refreshSnapshot();
				showNotice(t("agentMarket.created"), 2000);
				return created;
			} catch (error) {
				reportAgentMarketError(error);
				return null;
			}
		},
		[refreshSnapshot],
	);

	const updateAgent = useCallback(
		async (agentId: string, patch: UpdateAgentProfileInput) => {
			try {
				const updated = await desktopApi.agentProfiles.update(agentId, patch);
				await refreshSnapshot();
				showNotice(t("agentMarket.saved"), 2000);
				return updated;
			} catch (error) {
				reportAgentMarketError(error);
				return null;
			}
		},
		[refreshSnapshot],
	);

	const deleteAgent = useCallback(
		async (agent: AgentProfile) => {
			// 主进程同样拒绝删除内置智能体；这里拦一次是为了给出可读提示，而不是把 IPC 错误串丢给用户。
			if (agent.builtin) {
				showNotice(t("agentMarket.builtinNoDelete"), 3000, "warning");
				return false;
			}
			try {
				const removed = await desktopApi.agentProfiles.remove(agent.id);
				// 返回 false（已不存在）也重拉：快照据此自愈，避免卡片继续显示幽灵条目。
				await refreshSnapshot();
				if (removed) showNotice(t("agentMarket.deleted"), 2000);
				return removed;
			} catch (error) {
				reportAgentMarketError(error);
				return false;
			}
		},
		[refreshSnapshot],
	);

	/**
	 * 批量删除：逐条删（主进程没有批量接口，单个 delete 的语义就是「不存在或内置 → false」），
	 * 最后只重拉一次快照。内置条目在调用前就被过滤掉——批量框里点不到它们，
	 * 这里再兜一层，避免把「删了 0 条」误报成成功。
	 */
	const deleteAgents = useCallback(
		async (agents: readonly AgentProfile[]): Promise<number> => {
			const targets = agents.filter((agent) => !agent.builtin);
			if (targets.length === 0) {
				showNotice(t("agentMarket.builtinNoDelete"), 3000, "warning");
				return 0;
			}
			let removed = 0;
			let failed = 0;
			for (const agent of targets) {
				try {
					if (await desktopApi.agentProfiles.remove(agent.id)) removed += 1;
				} catch {
					failed += 1;
				}
			}
			await refreshSnapshot();
			if (failed > 0) showNotice(t("agentMarket.bulkDeletePartial", { count: removed, failed }), 3200, "warning");
			else if (removed > 0) showNotice(t("agentMarket.batchDeleted", { count: removed }), 2200);
			return removed;
		},
		[refreshSnapshot],
	);

	const duplicateAgent = useCallback(
		async (agent: AgentProfile) => {
			try {
				const created = await desktopApi.agentProfiles.duplicate(agent.id);
				await refreshSnapshot();
				showNotice(t("agentMarket.duplicated", { name: created.name }), 2500);
				return created;
			} catch (error) {
				reportAgentMarketError(error);
				return null;
			}
		},
		[refreshSnapshot],
	);

	const resetBuiltinAgent = useCallback(
		async (agent: AgentProfile) => {
			try {
				const reset = await desktopApi.agentProfiles.resetBuiltin(agent.id);
				await refreshSnapshot();
				showNotice(t("agentMarket.builtinReset"), 2000);
				return reset;
			} catch (error) {
				reportAgentMarketError(error);
				return null;
			}
		},
		[refreshSnapshot],
	);

	const setSelectionDefault = useCallback(
		async (agent: AgentProfile) => {
			try {
				await desktopApi.agentProfiles.updateSettings({ selectionToolAgentId: agent.id });
				await refreshSnapshot();
				showNotice(t("agentMarket.settingsSaved"), 2000);
				return true;
			} catch (error) {
				reportAgentMarketError(error);
				return false;
			}
		},
		[refreshSnapshot],
	);

	return { createAgent, updateAgent, deleteAgent, deleteAgents, duplicateAgent, resetBuiltinAgent, setSelectionDefault };
}
