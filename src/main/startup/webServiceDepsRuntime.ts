import { agentEventTags } from "../../shared/ipc";
import { applyBoundAgentPersona } from "../agents/agentPersonaInstruction";
import { downgradeRunningStartedBefore, downgradeStaleRunning } from "../pi/derivedSubagents";
import type { WebServiceDependencies } from "../web/WebServiceManager";
import type { WebServiceContext } from "./webServiceContext";

/**
 * Web 服务依赖装配（第二部分）：发送/智能体绑定/运行时命令/DSH 工具与插件/安全等级/fork/子代理。
 *
 * 自 index.ts 的 `new WebServiceManager({...})` 对象字面量就地外移（2027-02 拆分），
 * 与 webServiceDepsWeb.ts 相接，键顺序与代码逐字保持；晚装配的单例（catalog / 运行时协调器 /
 * 智能体目录 / 终端）走 getter 现读。`webPersonaInjectedSessions` 是只在本半段用到的
 * 已注入集合，随本段一起搬走（创建时机仍在装配点，闭包捕获同一份 Set）。
 */
export function createWebRuntimeDeps(ctx: WebServiceContext) {
	const { appLogger, agentManager, dshAgentManager, dshHost, securityStore, sessionForkCommands, getSessionCatalog, getSessionRuntimeCoordinator, getAgentProfileStore, getTerminalManager, emitSessionRuntimeEvent, emitSessionRuntimeDetach, emitReplacementState, stopSessionRuntime } = ctx;

	const webPersonaInjectedSessions = new Set<string>();
	return {
		sendSessionPrompt: async (input) => {
			// 绑定智能体的会话：仅在首轮把角色设定拼进载荷（dsh 退化为可见前缀，其余后端走隐藏通道）。
			// 桌面 IPC 是另一个发送入口，两边共用 applyBoundAgentPersona 的判定与组合语义；
			// 注入点必须在 send 之前——会话首条一旦落盘，角色设定就随上下文生效。
			const persona = getAgentProfileStore()?.getBoundAgent(input.sessionId)?.systemPrompt;
			const record = persona ? getSessionCatalog().get(input.sessionId) : undefined;
			const applied = applyBoundAgentPersona({
				prompt: input,
				persona,
				sessionStatus: record?.status,
				backend: record?.backend,
				alreadyInjected: webPersonaInjectedSessions.has(input.sessionId),
			});
			if (applied.injected) {
				void appLogger.debug("session", "Bound agent persona injected (web)", { sessionId: input.sessionId, backend: record?.backend ?? "pi", personaChars: persona?.length ?? 0 });
			}
			// 晚装配单例在回调入口取一次当前实例（本块构造时协调器还未赋值）。
			const sessionRuntimeCoordinator = getSessionRuntimeCoordinator();
			const result = await sessionRuntimeCoordinator.send(applied.prompt);
			if (result.accepted && applied.injected) webPersonaInjectedSessions.add(input.sessionId);
			if (result.agentId) {
				const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, agentEventTags.agentsState, tab);
			}
			return result;
		},
		// 智能体目录（只读投影）：Web 端「智能体」面板与「使用」（建会话 + 落绑定）同源。
		// store 在启动后段才装配（闭包在请求时求值）：未装配时返回 undefined → 路由回 503，
		// Web 端不展示一个空面板。
		listAgentProfiles: () => {
			const agentProfileStore = getAgentProfileStore();
			return agentProfileStore ? agentProfileStore.list() : undefined;
		},
		getSessionAgentBindings: () => {
			const agentProfileStore = getAgentProfileStore();
			return agentProfileStore ? agentProfileStore.getSnapshot().settings.sessionAgentBindings : undefined;
		},
		bindSessionAgent: async (sessionId, agentId) => {
			const agentProfileStore = getAgentProfileStore();
			if (!agentProfileStore) throw new Error("agent profiles are not available");
			await agentProfileStore.bindSession({ sessionId, agentId });
		},
		listSessionRuntimes: () => getSessionRuntimeCoordinator().listRuntimes(),
		listPendingUiRequests: () => getSessionRuntimeCoordinator().listPendingUiRequests(),
		respondToUi: (input) => getSessionRuntimeCoordinator().respondToUi(input),
		// S6.3：Web 端 DSH 工具面板（goals/subagents/skills）——与桌面 IPC 同源
		listDshSubagents: (agentId) => dshAgentManager.listSubagents(agentId),
		readDshSubagentHistory: (agentId, childSessionId, beforeSeq, maxMessages) => dshAgentManager.readSubagentHistory(agentId, childSessionId, beforeSeq, maxMessages),
		listDshSkills: (agentId) => dshAgentManager.listSkills(agentId),
		// S6.5：Web 端 DSH 插件管理（动态 Cordis 插件，与桌面配置页同源）
		listDshDynamicPlugins: () => dshHost.listDynamicPlugins(),
		listDshStaticPlugins: () => dshHost.listStaticPlugins(),
		uninstallDshUserPlugin: (input) => dshHost.uninstallUserPlugin(input),
		installDshPlugin: (input) => dshHost.installDynamicPlugin(input),
		runDshPlugin: (input) => dshHost.runDynamicPlugin(input),
		stopDshPlugin: (input) => dshHost.stopDynamicPlugin(input),
		uninstallDshPlugin: (input) => dshHost.uninstallDynamicPlugin(input),
		listSessionRuntimeModels: (target) => getSessionRuntimeCoordinator().listRuntimeModels(target),
		stopSessionRuntime: stopSessionRuntime,
		abortSessionRuntime: (target) => getSessionRuntimeCoordinator().abortRuntime(target),
		restartSessionRuntime: async (target) => {
			getTerminalManager().closeAgent(target.agentId);
			const result = await getSessionRuntimeCoordinator().restartRuntime(target);
			if (result.ok) {
				if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
				// 与桌面 IPC 同规约：新 runtime 的消息窗口在绑定前 flush 会被丢弃，
				// 重启后必须重下发（id 已由会话级身份延续保持稳定，不触发整窗 remount）。
				emitReplacementState(result.value.runtime, true);
			}
			return result;
		},
		compactSessionRuntime: (target, prompt) => getSessionRuntimeCoordinator().compactRuntime(target, prompt),
		getSessionRuntimeState: (target) => getSessionRuntimeCoordinator().getRuntimeState(target),
		listSessionRuntimeCommands: (target) => getSessionRuntimeCoordinator().listRuntimeCommands(target),
		exportSessionRuntimeHtml: (target) => getSessionRuntimeCoordinator().exportRuntimeHtml(target),
		editSessionRuntimeMessage: (target, messageId, newText) => getSessionRuntimeCoordinator().editRuntimeMessage(target, messageId, newText),
		deleteSessionRuntimeMessage: (target, messageId) => getSessionRuntimeCoordinator().deleteRuntimeMessage(target, messageId),
		listRewindCheckpoints: (target, params) => getSessionRuntimeCoordinator().listRewindCheckpoints(target, params),
		getRewindCheckpointDiff: (target, checkpointId) => getSessionRuntimeCoordinator().getRewindCheckpointDiff(target, checkpointId),
		restoreRewindCheckpoint: (target, checkpointId, scope) => getSessionRuntimeCoordinator().restoreRewindCheckpoint(target, checkpointId, scope),
		prepareSessionRuntimeResend: (target, messageId) => getSessionRuntimeCoordinator().prepareRuntimeResend(target, messageId),
		setSessionRuntimeModel: (target, provider, modelId, modelName) => getSessionRuntimeCoordinator().setRuntimeModel(target, provider, modelId, modelName),
		setSessionRuntimeThinking: (target, level) => getSessionRuntimeCoordinator().setRuntimeThinking(target, level),
		setSessionRuntimePermission: (target, preset) => getSessionRuntimeCoordinator().setRuntimePermission(target, preset),
		// Pi 会话安全等级：与桌面 SecurityLevelMenu 同源（SecurityStore 全局默认 + 会话覆盖），
		// 路由层已校验会话/后端/等级，这里只做存储写入（策略快照由 SecurityStore 刷新）。
		getSecurityConfig: () => securityStore.getConfig(),
		setSessionSecurityLevel: (sessionId, levelId) => securityStore.setSessionLevel(sessionId, levelId),
		// fork/clone 与桌面 IPC 同源（sessionForkCommands 统一命令层）：
		// 重发/编辑 fork 化（mutationFork/branchMode）、supersededBy 隐藏、
		// catalog 刷新广播都在那一层维护，两端行为必须一致。
		cloneSessionRuntime: (target) => sessionForkCommands.cloneRuntimeSession(target),
		getForkMessages: (target) => getSessionRuntimeCoordinator().getRuntimeForkMessages(target),
		forkRuntimeSession: (target, entryId, options) => sessionForkCommands.forkRuntimeSession(target, entryId, options),
		// Web 重发/编辑 fork 化：冷会话（无 runtime）先激活（与桌面 activateRuntime 同源）
		activateSessionRuntime: (sessionId) => getSessionRuntimeCoordinator().activateRuntime(sessionId),
		// 会话活动监控（第二批 strips）：与桌面 sessionIpc.ts 同源同闸门
		listSessionSubagents: async (sessionId) => {
			const entry = getSessionCatalog().get(sessionId);
			if (!entry?.filePath) return [];
			// 锚点对账要在读取侧做（liveRuntimeStartedAt，同桌面 sessionIpc）：
			// 运行中子代理只剩 start 锚点（record 完成时才写），不传对账时间会一律
			// 合成 stopped，面板误显「已停止」（issue #300）。
			const liveTarget = getSessionRuntimeCoordinator().getTarget(sessionId);
			const liveTab = liveTarget ? agentManager.list().find((tab) => tab.id === liveTarget.agentId) : undefined;
			let records = await agentManager.readSessionSubagentRecords(entry.filePath, { liveRuntimeStartedAt: liveTab?.createdAt });
			// 与桌面同款对账：无活 runtime 时把残留 running 降级（终态通知未落盘）；
			// 活 runtime 按本代启动时间降级上一代派发的 running。
			if (!liveTarget) {
				if (!getSessionRuntimeCoordinator().isActivating(sessionId)) {
					records = downgradeStaleRunning(records);
				}
			} else {
				if (liveTab?.createdAt) {
					records = downgradeRunningStartedBefore(records, liveTab.createdAt);
				}
			}
			return records;
		},
		listSessionTodo: (sessionId) => {
			const entry = getSessionCatalog().get(sessionId);
			// DSH/生图会话无 pi 会话文件，无 todo 快照
			if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen") return Promise.resolve(undefined);
			return agentManager.readSessionTodo(entry.filePath);
		},
	} satisfies Partial<WebServiceDependencies>;
}
