import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { useStore, useSetAtom } from "jotai";
import { applySessionRuntimeEventAtom, cacheSessionMessagesAtom, sessionRecordsAtom, setSessionHistoryMutationOverlayAtom, setSessionMessageLoadStateAtom } from "../../atoms/session-atoms";
import { sessionIdByRuntimeAgentIdAtomFamily, sessionRuntimeBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { dshRuntimeStatusAtom } from "../../atoms/dsh-atoms";
import { openSettingsAtom } from "../../atoms/app-ui-atoms";
import { canRunSessionAction, isLiveRuntimeStatus, requireSessionCommand, resolveSessionRunState, sessionRunCapabilities, SessionCommandFailure, toSessionRuntimeTarget, type SessionRunCapabilities, type SessionRunAction } from "../../utils/sessionCommands";
import { sessionHistoryUnavailableState } from "../../utils/sessionHistoryAvailability";
import { DSH_INSTALL_SETTINGS_TARGET, maybeHintMissingDshRunnerNode, showDshRuntimeBlockHint } from "../../utils/dshRuntimeHint";
import { dshSendBlockReason } from "../../../../shared/types/dshRuntime";
import { isPendingAgentId, type PendingAgentTab } from "../../rendererUtils";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import type { NoticeKind } from "../../utils/notice";
import type { AgentRuntimeState, AgentTab, SessionRecord, SessionRuntimeTarget } from "../../../../shared/types";
import type { QueuedPrompt } from "../useQueuedPrompt";

/** 确认弹窗的最小切片（关闭匿名会话/重启运行中会话需要确认） */
export interface RunControlConfirmOverlay {
	showConfirm: (options: { title: string; message: string; danger?: boolean; confirmLabel?: string; onConfirm: () => void }) => void;
	clearConfirm: () => void;
}

export interface SessionRunControlDeps {
	agents: AgentTab[];
	activeAgent: AgentTab | undefined;
	activeAgentId: string | undefined;
	activeProjectId: string | undefined;
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	overlays: RunControlConfirmOverlay;
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
	selectSessionCommand: (projectId: string, sessionId: string, force?: boolean) => void | Promise<void>;
	registerOpenSession: (sessionId: string, mode: "permanent" | "preview") => void;
	getSessionRecord: (sessionId: string) => SessionRecord | undefined;
	pendingAgentsRef: MutableRefObject<PendingAgentTab[]>;
	setPendingAgents: (updater: PendingAgentTab[] | ((current: PendingAgentTab[]) => PendingAgentTab[])) => void;
	queueFlushBySessionRef: MutableRefObject<Set<string>>;
	queuedPromptsRef: MutableRefObject<Record<string, QueuedPrompt[]>>;
}

/**
 * 会话运行控制域：runtime target 解析、克隆/关闭/中止/重启/重载、能力快照（capabilities）。
 * - 四个 busy 态（restarting/activating/stopping/reloading）由本 hook 持有，
 *   供 Tab 下拉/侧栏菜单的 loading 反馈；
 * - runSessionControl 是全状态统一入口（start/abort/restart/reload 按能力分派）；
 * - pendingAgents 状态留在 App（创建流程与重启流程共享），经 ref+setter 注入。
 */
export function useSessionRunControl({ agents, activeAgent, activeAgentId, activeProjectId, showToast, overlays, refreshProjectSessions, selectSessionCommand, registerOpenSession, getSessionRecord, pendingAgentsRef, setPendingAgents, queueFlushBySessionRef, queuedPromptsRef }: SessionRunControlDeps) {
	const store = useStore();
	const applyRuntimeEvent = useSetAtom(applySessionRuntimeEventAtom);
	const setMutationOverlay = useSetAtom(setSessionHistoryMutationOverlayAtom);
	const setSessionMessageLoadState = useSetAtom(setSessionMessageLoadStateAtom);
	const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);

	const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
	const [activatingSessionId, setActivatingSessionId] = useState<string | null>(null);
	const [stoppingAgentId, setStoppingAgentId] = useState<string | null>(null);
	const [reloadingSessionId, setReloadingSessionId] = useState<string | null>(null);
	// state 负责呈现；首次 await 前按会话加锁，避免同轮点击以及克隆/重启互相抢绑定。
	const replacingSessionIdsRef = useRef(new Set<string>());

	const getRuntimeTargetForSession = (sessionId: string | undefined) => (sessionId ? toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))) : undefined);
	// target 存在不代表 live（error/closed 终态仍持有绑定）：改文件前是否要先停 Agent
	// 必须按 runtime status 判定，避免对已死进程误发 stop。
	const isSessionRuntimeLive = (sessionId: string) => isLiveRuntimeStatus(store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))?.status);
	const getRuntimeTargetForAgent = (agentId: string | undefined) => {
		if (!agentId) return undefined;
		const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(agentId));
		return getRuntimeTargetForSession(sessionId);
	};

	async function openReplacedRuntimeSession(projectId: string | undefined, targetSessionId: string | undefined) {
		if (!projectId || !targetSessionId) return;
		await refreshProjectSessions(projectId);
		registerOpenSession(targetSessionId, "permanent");
		await selectSessionCommand(projectId, targetSessionId, true);
	}

	/** 克隆锁与重启共用，项目归属在请求前从原会话快照取得。 */
	async function cloneAgentSession(agentId: string) {
		const target = getRuntimeTargetForAgent(agentId);
		if (!target || replacingSessionIdsRef.current.has(target.sessionId)) return;
		const projectId = store.get(sessionRecordsAtom)[target.sessionId]?.projectId ?? agents.find((agent) => agent.id === agentId)?.projectId;
		replacingSessionIdsRef.current.add(target.sessionId);
		try {
			const result = requireSessionCommand(await api.sessions.cloneRuntime(target));
			if (result?.cancelled) {
				showToast(t("app.sessionCopyCancelled"));
				return;
			}
			showToast(t("app.currentSessionCopied"));
			await refreshRuntimeState(agentId);
			await openReplacedRuntimeSession(projectId, result.targetSessionId);
		} catch (err) {
			showToast(err instanceof Error ? err.message : String(err), 5000);
		} finally {
			replacingSessionIdsRef.current.delete(target.sessionId);
		}
	}

	function applyAgentRuntimeState(agentId: string, incoming: AgentRuntimeState) {
		const target = getRuntimeTargetForAgent(agentId);
		if (!target) return undefined;
		applyRuntimeEvent({
			...target,
			sourceChannel: "agents:runtime-state",
			payload: { agentId, state: incoming },
		});
		return store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId))?.state;
	}

	async function refreshRuntimeState(agentId = activeAgentId) {
		if (!agentId || isPendingAgentId(agentId)) return;
		const target = getRuntimeTargetForAgent(agentId);
		if (!target) return;
		const result = await api.sessions.getRuntimeState(target).catch(() => undefined);
		if (!result?.ok) return;
		const current = getRuntimeTargetForAgent(agentId);
		const response = result.value;
		// 查询期间克隆/重启可能已换绑，不能把旧快照重新包装成新一代运行时事件。
		if (!current || current.sessionId !== response.target.sessionId || current.agentId !== response.target.agentId || current.runtimeGeneration !== response.target.runtimeGeneration) return;
		applyRuntimeEvent({
			...response.target,
			sourceChannel: "agents:runtime-state",
			payload: { agentId, state: response.value },
		});
	}

	/**
	 * 从磁盘重新加载会话消息（外部修改会话文件后刷新时间线）。
	 * 仅用于未启动/异常（无 live runtime）的会话：live 会话刷新应走「重启 Agent」，
	 * 直接 force 磁盘会覆盖运行时内存中的流式消息。force 覆盖缓存后，所有展示该会话的
	 * 时间线（含分屏栏）都会通过 sessionMessagesCacheAtom 订阅自动更新。
	 */
	async function reloadSessionMessages(sessionId: string) {
		if (!sessionId) return;
		// live 运行时（starting/idle/running）不能强刷磁盘，会覆盖内存中的流式消息；
		// error/closed 终态仍持有绑定（getRuntimeTargetForSession 有 target），但进程已死，
		// 应当允许从磁盘刷新——这里必须按 status 判 live，不能用 target 判（否则 error/closed 的重载入口会被静默吞掉）。
		if (isSessionRuntimeLive(sessionId)) return;
		// 标记重载中：Tab 栏「重载」菜单项/tab 徽章 + 会话消息区域遮罩据此显示 loading 动画
		setReloadingSessionId(sessionId);
		setMutationOverlay({ sessionId, kind: "reloading" });
		setSessionMessageLoadState({ sessionId, state: { status: "loading" } });
		try {
			const page = await api.sessions.readRecordMessagePage(sessionId, undefined, 100);
			// DSH host 被手动停止：读盘返回带原因的空页，不是「空会话」。
			// 必须早退，否则 force 写空缓存会把这个会话洗成空白（看着像数据丢了）。
			const unavailable = sessionHistoryUnavailableState(page);
			if (unavailable) {
				setSessionMessageLoadState({ sessionId, state: unavailable });
				return;
			}
			setCacheMessages({
				sessionId,
				messages: page.messages,
				source: "disk",
				expectedRevision: 0,
				page: { total: page.total, nextBefore: page.nextBefore },
				force: true,
			});
			setSessionMessageLoadState({ sessionId, state: { status: "ready" } });
			showToast(t("app.sessionReloaded"), 2000);
		} catch (error) {
			setSessionMessageLoadState({
				sessionId,
				state: { status: "error", error: error instanceof Error ? error.message : String(error) },
			});
			showToast(t("app.sessionReloadFailed", { error: error instanceof Error ? error.message : String(error) }), 5000);
		} finally {
			setReloadingSessionId((current) => (current === sessionId ? null : current));
			setMutationOverlay({ sessionId, kind: null });
		}
	}

	/**
	 * 关闭 Agent：杀掉绑定的 pi/DSH 进程并解绑（会话记录、历史消息与 Tab 全部保留，
	 * 之后可再「启动 Agent」）。与「停止回答」（abort，只中断当前回合）语义不同。
	 * 匿名会话的记录会被主进程丢弃，因此入口走 requestCloseAgent 先确认。
	 */
	async function closeAgent(agentId: string) {
		if (isPendingAgentId(agentId)) return;
		const target = getRuntimeTargetForAgent(agentId);
		if (!target) {
			// 没有绑定 = 没有可关闭的进程（渲染层快照可能已过期）：给出可见原因，
			// 而不是静默返回让用户以为「点了没反应」。要恢复运行请用「启动 Agent」。
			showToast(t("sessionCommand.runtimeUnavailable"), 3000);
			return;
		}
		// 标记停止中：Tab 栏「停止」菜单项/tab 徽章 + 会话消息区域遮罩据此显示 loading 动画
		setStoppingAgentId(agentId);
		setMutationOverlay({ sessionId: target.sessionId, kind: "stopping" });
		try {
			requireSessionCommand(await api.sessions.stopRuntime(target));
		} finally {
			setStoppingAgentId((current) => (current === agentId ? null : current));
			setMutationOverlay({ sessionId: target.sessionId, kind: null });
		}
	}

	function requestCloseAgent(agent: Pick<AgentTab, "id" | "noSession">): Promise<void> {
		if (!agent.noSession) return closeAgent(agent.id);
		overlays.showConfirm({
			title: t("app.anonymousChatCloseTitle"),
			message: t("app.anonymousChatCloseBody"),
			danger: true,
			confirmLabel: t("common.close"),
			onConfirm: () => {
				overlays.clearConfirm();
				void closeAgent(agent.id).catch((error) => {
					showToast(error instanceof Error ? error.message : String(error), 5000);
				});
			},
		});
		return Promise.resolve();
	}

	/**
	 * 关闭 Agent（会话维度入口，供 Tab 下拉使用）：复用侧栏 Agent 菜单的确认逻辑
	 * 与 closeAgent 链路（杀进程 + 解绑）。匿名会话内容不可恢复，会先弹确认。
	 */
	function requestCloseAgentForSession(sessionId: string): void {
		const target = getRuntimeTargetForSession(sessionId);
		if (!target) {
			showToast(t("sessionCommand.runtimeUnavailable"), 3000);
			return;
		}
		void requestCloseAgent({
			id: target.agentId,
			noSession: getSessionRecord(sessionId)?.noSession,
		});
	}

	async function abortAgent(agentId = activeAgentId) {
		if (!agentId || isPendingAgentId(agentId)) return;
		const target = getRuntimeTargetForAgent(agentId);
		if (!target) {
			showToast(t("sessionCommand.runtimeUnavailable"), 4000);
			return;
		}
		// 立即清除流式状态，让思考气泡和 loading 立刻消失，不等后端 RPC 返回
		const previous = store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId))?.state;
		if (previous) {
			applyAgentRuntimeState(agentId, { ...previous, isStreaming: false });
		}
		try {
			requireSessionCommand(await api.sessions.abortRuntime(target));
		} catch (error) {
			// abort 失败必须可见：之前此处直接 throw 变成未处理 rejection，
			// 用户点停止后毫无反馈、agent 继续运行，表现为「停止不了」。
			showToast(error instanceof Error ? error.message : String(error), 5000);
		}
		// 不调用 refreshRuntimeState：AgentManager.abort() 会通过 emitState 推送正确状态，
		// 避免后端 get_state 返回过时的 isStreaming: true 覆盖前端立刻设的 false。
	}

	/**
	 * restartRuntime 的核心流程：pending（重启中）动画 + 替换回调 + toast。
	 * restartingAgent 仅用于侧栏/tab 的重启中反馈；找不到时（如已 detach 的终态
	 * agent 不在 inventory）也照常重启，不因缺少展示对象而阻断。
	 */
	async function restartRuntimeTarget(target: SessionRuntimeTarget, restartingAgent?: AgentTab) {
		if (restartingAgent) {
			setRestartingAgentId(restartingAgent.id);
			pendingAgentsRef.current = [
				...pendingAgentsRef.current.filter((agent) => agent.id !== restartingAgent.id),
				{
					...restartingAgent,
					status: "starting",
					pendingKind: "restart",
					pendingStartedAt: Date.now(),
				},
			];
			setPendingAgents(pendingAgentsRef.current);
		}
		try {
			const replacement = requireSessionCommand(await api.sessions.restartRuntime(target));
			if (restartingAgent) {
				pendingAgentsRef.current = pendingAgentsRef.current.filter((agent) => agent.id !== restartingAgent.id);
				setPendingAgents(pendingAgentsRef.current);
			}
			void refreshRuntimeState(replacement.runtime.agentId);
			showToast(t("app.agentRestarted"), 2000);
		} catch (error) {
			if (restartingAgent) {
				pendingAgentsRef.current = pendingAgentsRef.current.map((agent) => (agent.id === restartingAgent.id ? { ...agent, status: "error" } : agent));
				setPendingAgents(pendingAgentsRef.current);
			}
			throw error;
		} finally {
			if (restartingAgent) {
				setRestartingAgentId((current) => (current === restartingAgent.id ? null : current));
			}
		}
	}

	async function restartActiveAgent(agentId = activeAgentId) {
		if (!agentId) return;
		// 显式 ID 已失效时不能借当前焦点兜底，否则模型选择器等异步入口会重启别的会话。
		const restartingAgent = agents.find((agent) => agent.id === agentId) ?? (activeAgent?.id === agentId ? activeAgent : undefined);
		const target = getRuntimeTargetForAgent(agentId);
		if (!target) {
			// error/closed 终态仍保留 agentId+runtimeGeneration（target 存在，可幂等重启）；
			// 只有 detached/无绑定（无 target）才会走到这里。该场景由 restartSessionAnyState
			// 改走 activateRuntime 启动，这里兜底防竞态/其他入口（如模型切换重启）静默无反馈。
			showToast(t("sessionCommand.runtimeUnavailable"), 4000);
			return;
		}
		const capabilities = getSessionRunCapabilities(target.sessionId);
		if (!capabilities || !canRunSessionAction(capabilities, "restart")) return;
		replacingSessionIdsRef.current.add(target.sessionId);
		try {
			await restartRuntimeTarget(target, restartingAgent);
		} catch (error) {
			showToast(error instanceof Error ? error.message : String(error), 5000);
		} finally {
			replacingSessionIdsRef.current.delete(target.sessionId);
		}
	}

	/**
	 * 按会话状态分派「重启会话」：失败/未启动/空闲/运行中的统一入口。
	 * - 有绑定（runtime.agentId 仍在）→ restartRuntimeTarget；error/closed 终态也能幂等重启。
	 * - 无绑定（未启动/detached）→ activateRuntime 启动新 Agent。
	 * - restartRuntime 若因「主进程已惰性解绑」抛 SESSION_RUNTIME_UNAVAILABLE/CHANGED
	 *   （agent crash 后发消息激活触发主进程 unbindTerminalAgent 但不推事件，前端未同步），
	 *   降级 activateRuntime 重新绑定启动——根治「右键重启没反应」。
	 */
	async function restartSessionAnyState(sessionId: string) {
		if (!sessionId) return;
		// 确认框等待期间能力也会变化：在实际重启处重查队列/握手/互斥态，不只靠菜单置灰。
		const capabilities = getSessionRunCapabilities(sessionId);
		if (!capabilities || !canRunSessionAction(capabilities, "restart")) return;
		replacingSessionIdsRef.current.add(sessionId);
		try {
			const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
			const target = toSessionRuntimeTarget(sessionId, runtime);
			if (target) {
				try {
					await restartRuntimeTarget(
						target,
						agents.find((agent) => agent.id === target.agentId),
					);
					return;
				} catch (error) {
					const canFallback = error instanceof SessionCommandFailure && (error.code === "SESSION_RUNTIME_UNAVAILABLE" || error.code === "SESSION_RUNTIME_CHANGED");
					if (!canFallback) {
						showToast(error instanceof Error ? error.message : String(error), 5000);
						return;
					}
					// 主进程绑定已解绑（前端未同步）：降级为重新激活启动，不重复报错。
					// 先清掉 restart 失败残留的 error pending，避免激活成功后侧栏出现两个同会话 agent。
					pendingAgentsRef.current = pendingAgentsRef.current.filter((agent) => agent.id !== target.agentId);
					setPendingAgents(pendingAgentsRef.current);
				}
			}
			// 未启动/已解绑：激活会话（ensureRuntime 对无绑定会话 create 新 Agent，幂等去重防重复点击）。
			// DSH 会话 runtime 不可用（未安装/损坏）时 host 无法 fork，activateRuntime 只会抛
			// 模块解析裸报错——给「去安装」提示（含直达入口）而不是把底层错误甩给用户。
			const restartRecord = store.get(sessionRecordsAtom)[sessionId];
			if (restartRecord?.backend === "dsh") {
				const dshStatus = store.get(dshRuntimeStatusAtom);
				if (dshSendBlockReason(dshStatus.state)) {
					showDshRuntimeBlockHint(() => store.set(openSettingsAtom, DSH_INSTALL_SETTINGS_TARGET), dshStatus.state, dshStatus.reason, {
						installed: dshStatus.runtimeVersion,
						declared: dshStatus.declaredRuntimeVersion,
					});
					return;
				}
				maybeHintMissingDshRunnerNode(() => store.set(openSettingsAtom, { tab: "dev", section: "dsh-runner-node" }));
			}
			// 重启活会话走 restartRuntimeTarget→restartingAgentId→SessionSurfaceStage 的 isRestarting 遮罩；
			// 这里（无绑定）没有 restartingAgentId，需显式设置 activating 遮罩，让会话消息区域也有加载动画。
			setActivatingSessionId(sessionId);
			setMutationOverlay({ sessionId, kind: "activating" });
			try {
				const activated = requireSessionCommand(await api.sessions.activateRuntime(sessionId));
				void refreshRuntimeState(activated.agentId);
				showToast(t("app.sessionStarted"), 2000);
			} catch (error) {
				showToast(error instanceof Error ? error.message : String(error), 5000);
			} finally {
				setActivatingSessionId((current) => (current === sessionId ? null : current));
				setMutationOverlay({ sessionId, kind: null });
			}
		} finally {
			replacingSessionIdsRef.current.delete(sessionId);
		}
	}

	async function exportAgentHtml(agentId: string) {
		if (isPendingAgentId(agentId)) return;
		try {
			const target = getRuntimeTargetForAgent(agentId);
			if (!target) return;
			const result = requireSessionCommand(await api.sessions.exportRuntimeHtml(target)).value as {
				path: string;
			};
			showToast(t("app.exportedPath", { path: result.path }), 3500);
		} catch (err) {
			showToast(err instanceof Error ? err.message : String(err), 5000);
		}
	}

	/**
	 * 会话运行控制能力（全状态）：读当前 runtime 快照 → 纯函数策略 → 四项能力。
	 * UI（Tab 下拉 / 侧栏右键菜单）只消费这里的结果，不再各自写 isLiveRuntimeStatus 分叉，
	 * 根治「某些状态没有入口」和「两处判定不一致」。
	 */
	function getSessionRunCapabilities(sessionId: string | undefined): SessionRunCapabilities | undefined {
		if (!sessionId) return undefined;
		const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
		const target = toSessionRuntimeTarget(sessionId, runtime);
		const busy = replacingSessionIdsRef.current.has(sessionId) || activatingSessionId === sessionId || reloadingSessionId === sessionId || (Boolean(target?.agentId) && restartingAgentId === target?.agentId) || queueFlushBySessionRef.current.has(sessionId);
		const activeQueued = queuedPromptsRef.current[sessionId] ?? [];
		return sessionRunCapabilities({
			state: resolveSessionRunState(runtime, Boolean(target)),
			hasBinding: Boolean(target),
			busy,
			hasInFlightQueuedPrompt: activeQueued.some((qp) => qp.status === "sending" || qp.status === "unknown"),
		});
	}

	/**
	 * 会话运行控制统一入口：任意状态、任意入口（Tab 下拉 / 侧栏菜单 / 快捷键）都走这里。
	 * - start：未启动/已解绑/error/closed → 有绑定走 restartRuntime 重建进程，无绑定走 activateRuntime。
	 * - abort：只中断当前正在执行的回合（abort），进程与绑定保留、可立即继续对话；
	 *   与输入框的「停止」同义——要杀进程请走「关闭 Agent」（closeAgent）。
	 * - restart：与 start 同路径（对 live 语义即重启）；running 时先弹确认，避免误杀正在输出的回答。
	 * - reload：无进程时从磁盘刷新消息文件。
	 */
	async function runSessionControl(sessionId: string, action: SessionRunAction): Promise<void> {
		if (!sessionId) return;
		const capabilities = getSessionRunCapabilities(sessionId);
		if (!capabilities || !canRunSessionAction(capabilities, action)) return;

		if (action === "reload") {
			await reloadSessionMessages(sessionId);
			return;
		}

		if (action === "abort") {
			const target = getRuntimeTargetForSession(sessionId);
			if (!target) {
				// 进程已经不存在（终态被主进程惰性解绑）：没有可中断的回合。
				showToast(t("sessionCommand.runtimeUnavailable"), 3000);
				return;
			}
			// abortAgent 自带失败 toast 与「立即清流式态」处理，不抛异常。
			await abortAgent(target.agentId);
			return;
		}

		// action === "start" | "restart"
		// live 态下这是「杀掉正在跑的进程重建」：会中断当前回答，必须先确认。
		if (capabilities.requiresConfirm) {
			overlays.showConfirm({
				title: t("runControl.restartRunningTitle"),
				message: t("runControl.restartRunningBody"),
				confirmLabel: t("app.restart"),
				onConfirm: () => {
					overlays.clearConfirm();
					void restartSessionAnyState(sessionId);
				},
			});
			return;
		}
		await restartSessionAnyState(sessionId);
	}

	return {
		restartingAgentId,
		activatingSessionId,
		stoppingAgentId,
		reloadingSessionId,
		getRuntimeTargetForSession,
		getRuntimeTargetForAgent,
		isSessionRuntimeLive,
		openReplacedRuntimeSession,
		cloneAgentSession,
		applyAgentRuntimeState,
		refreshRuntimeState,
		reloadSessionMessages,
		closeAgent,
		requestCloseAgent,
		requestCloseAgentForSession,
		abortAgent,
		restartActiveAgent,
		restartSessionAnyState,
		exportAgentHtml,
		getSessionRunCapabilities,
		runSessionControl,
	};
}
