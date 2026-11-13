import { isLocalProject } from "../../shared/projectLocation";
import type { AcpAgentManager } from "../acp/AcpAgentManager";
import { CompositeAgentGateway } from "../agents/CompositeAgentGateway";
import { memoryDirOfMount, sourcesOfMount } from "../agentMemory/agentMemoryMounts";
import { runLearnerForAgent } from "../agentMemory/agentMemoryLearner";
import type { AgentMemoryMount } from "../agentMemory/agentMemoryMounts";
import type { DshAgentManager } from "../dsh/DshAgentManager";
import type { AppLogger } from "../logging/AppLogger";
import { notifySessionFinished, type AgentToastDeps } from "../notifications/agentToast";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { RemoteSessionMessageMutationPort } from "../remote/RemoteSessionHistoryWriter";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { SessionRuntimeCoordinator, type SessionRuntimeBinding } from "../sessions/SessionRuntimeCoordinator";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SendPromptInput, SendPromptResult } from "../../shared/types";

/**
 * 多后端会话协调装配（自 index.ts 的 whenReady 装配体就地外移，行为零变化）：
 * 合成网关（pi + dsh + acp）→ 三个回合结算订阅 → 会话运行时协调器 → 解绑推送与活性探针。
 */
export interface SessionRuntimeContext {
	readonly acpAgentManager: AcpAgentManager;
	readonly agentManager: AgentManager;
	readonly agentToastDeps: () => AgentToastDeps;
	readonly appLogger: AppLogger;
	readonly createAgentMemoryMount: (cwd?: string) => AgentMemoryMount;
	readonly dshAgentManager: DshAgentManager;
	readonly emitSessionRuntimeDetach: (binding: SessionRuntimeBinding) => void;
	readonly getRemoteSessionMessageMutation: () => RemoteSessionMessageMutationPort | undefined;
	readonly memoryLearnComplete: (sessionId: string, input: { systemPrompt: string; text: string }) => Promise<string>;
	readonly projectStore: ProjectStore;
	readonly sendAgentPromptWithIntegrations: (input: SendPromptInput) => Promise<SendPromptResult>;
	readonly sessionCatalog: SessionCatalog;
	readonly settingsStore: SettingsStore;
}

export interface SessionRuntimeHandle {
	readonly compositeAgentGateway: CompositeAgentGateway;
	readonly sessionRuntimeCoordinator: SessionRuntimeCoordinator;
}

export function startSessionRuntime(ctx: SessionRuntimeContext): SessionRuntimeHandle {
	const { acpAgentManager, agentManager, agentToastDeps, appLogger, createAgentMemoryMount, dshAgentManager, emitSessionRuntimeDetach, getRemoteSessionMessageMutation, memoryLearnComplete, projectStore, sendAgentPromptWithIntegrations, sessionCatalog, settingsStore } = ctx;

	const compositeAgentGateway = new CompositeAgentGateway([agentManager, dshAgentManager, acpAgentManager]);
	// 非 pi 后端没有 AgentManager 的内部完成通知：这里统一补「会话完成」。
	// pi 已经在自己内部发过（门控/文案一致），跳过避免双弹。
	compositeAgentGateway.onAgentSettled((info) => {
		const tab = compositeAgentGateway?.list().find((candidate) => candidate.id === info.agentId);
		if (!tab || (tab.backend ?? "pi") === "pi") return;
		notifySessionFinished(agentToastDeps(), { agentId: info.agentId, title: info.title, ...(tab.deckSessionId ? { sessionId: tab.deckSessionId } : {}) });
	});
	// 记忆学习循环：回合结算后按阈值尝试一次提炼（三后端统一走这里）。
	// 与上面的完成通知不同，pi 会话也要参与——记忆是跨后端的同一份数据。
	// 学习本身是可选增益：任何失败都只进日志，绝不让它反过来影响会话。
	compositeAgentGateway.onAgentSettled((info) => {
		const settings = settingsStore?.get();
		if (!settings?.agentMemoryEnabled || !settings.agentMemoryAutoLearnEnabled) return;
		const tab = compositeAgentGateway?.list().find((candidate) => candidate.id === info.agentId);
		if (!tab) return;
		const mount = createAgentMemoryMount(tab.cwd);
		void runLearnerForAgent(
			{
				root: memoryDirOfMount(mount),
				sources: sourcesOfMount(mount),
				complete: memoryLearnComplete,
				logger: {
					info: (channel, message, meta) => void appLogger.info(channel, message, meta),
					warn: (channel, message, meta) => void appLogger.warn(channel, message, meta),
				},
			},
			tab,
		).catch((error: unknown) => {
			void appLogger.warn("agent-memory", "learn pass crashed", { error: error instanceof Error ? error.message : String(error) });
		});
	});
	// 项目位置注入给会话协调器：远端会话在 pi 上报会话文件之前没有 ssh 身份，"这条会话的 runtime
	// 在哪台机器上"只能由项目 locator 回答（AgentManager 也按它路由 runtime）。位置真相同的单一
	// 来源仍然是 projectStore，这里只给一个只读取值器。
	const sessionRuntimeCoordinator = new SessionRuntimeCoordinator(
		sessionCatalog,
		compositeAgentGateway,
		sendAgentPromptWithIntegrations,
		appLogger,
		(projectId) => {
			const project = projectStore.get(projectId);
			return project && !isLocalProject(project) ? project.locator : undefined;
		},
		// 远端会话文件改写端口（P4.5c）：调用时解析——端口在 registerIpc() 里才装配（见模块级声明）。
		() => getRemoteSessionMessageMutation(),
	);
	// 终态惰性解绑（getAgentId → unbindTerminalAgent）发生在查询路径里，必须把解绑推给渲染层：
	// 否则渲染层快照停在 error，红点常亮且「关闭 Agent」永远对不上存在的运行实例。
	sessionRuntimeCoordinator.setDetachedNotifier((binding) => emitSessionRuntimeDetach(binding));
	// catalog 外部删除清理的活性探针：预热激活后 pi 可能尚未写出会话文件，
	// 有活跃绑定的记录不得被扫描当「外部删除」剔掉。
	sessionCatalog.setSessionLivenessProbe((sessionId) => sessionRuntimeCoordinator?.hasLiveRuntime(sessionId) === true);
	return { compositeAgentGateway, sessionRuntimeCoordinator };
}
