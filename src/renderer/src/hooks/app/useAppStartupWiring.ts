import { useEffect } from "react";
import type { createStore } from "jotai";
import { dshRuntimeStatusAtom, sessionRecordByIdAtomFamily } from "../../atoms";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import { isReplacementForPendingAgent, migrateAgentRecord, type PendingAgentTab } from "../../rendererUtils";
import type { NoticeKind } from "../../utils/notice";
import type { EnhanceModelSelection } from "../../../../shared/enhanceModelPreference";
import type { AgentTab, AppSettings, FocusTargetPayload, Project } from "../../../../shared/types";
import type { useOverlayActions } from "../useOverlayActions";
import type { usePiUpdate } from "../usePiUpdate";
import type { useWorkspacePanels } from "../useWorkspacePanels";

/**
 * App 启动接线：Agent 清单替换（pending → 真实 agent）与宿主 bootstrap 回调 + 首拉设置。
 *
 * - Agent 清单变更：pendingAgents 里被真实 agent 替换掉的条目要摘掉，同时把实时草稿镜像的
 *   键从 pending id 迁到真实 id（否则草稿在一次新建/替换后丢失）；
 * - bootstrapProps：主进程 → 渲染层的四类回调（项目清单变化 / 设置已应用 / 打开浏览器 /
 *   信任请求 / 焦点目标）。焦点目标里的 projectId 分支由 useSessionWorkspaceChrome 自己订阅，
 *   这里只接 sessionId 旧链路，不重复消费；
 * - 首拉设置：挂载时一次性拉 settings + imagegen 配置 + 外部编辑器，并在需要时触发
 *   「没有 pi」的首次检测（默认后端已是可用 DSH 时跳过）。
 */
export interface AppStartupWiringDeps {
	store: ReturnType<typeof createStore>;
	agents: AgentTab[];
	pendingAgentsRef: { current: PendingAgentTab[] };
	setPendingAgents: (next: PendingAgentTab[]) => void;
	livePromptByAgentRef: { current: Record<string, string> };
	activeProjectId: string | undefined;
	setActiveProjectId: (projectId: string | undefined) => void;
	setSettings: (next: AppSettings | ((current: AppSettings) => AppSettings)) => void;
	setSettingsLoaded: (loaded: boolean) => void;
	setImageGenConfig: (config: Awaited<ReturnType<typeof api.imagegen.getConfig>>) => void;
	setEnhanceModel: (selection: EnhanceModelSelection | null) => void;
	setEnhanceIncludeContext: (enabled: boolean) => void;
	setPromptSuggestionEnabled: (enabled: boolean) => void;
	setPromptSuggestionModel: (selection: EnhanceModelSelection | null) => void;
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	selectSessionCommand: (projectId: string, sessionId: string, scrollToEnd?: boolean) => void;
	openInBrowser: (url: string) => void;
	overlays: ReturnType<typeof useOverlayActions>;
	workspace: ReturnType<typeof useWorkspacePanels>;
	piUpdate: ReturnType<typeof usePiUpdate>;
}

export interface AppStartupWiring {
	bootstrapProps: {
		onProjectsChanged: (next: Project[]) => void;
		onSettingsApplied: (next: AppSettings) => void;
		onOpenInBrowser: (url: string) => void;
		onTrustRequest: ReturnType<typeof useOverlayActions>["setTrustRequest"];
		onFocusTarget: (target: FocusTargetPayload) => void;
	};
}

export function useAppStartupWiring(deps: AppStartupWiringDeps): AppStartupWiring {
	const {
		store,
		agents,
		pendingAgentsRef,
		setPendingAgents,
		livePromptByAgentRef,
		activeProjectId,
		setActiveProjectId,
		setSettings,
		setSettingsLoaded,
		setImageGenConfig,
		setEnhanceModel,
		setEnhanceIncludeContext,
		setPromptSuggestionEnabled,
		setPromptSuggestionModel,
		showToast,
		selectSessionCommand,
		openInBrowser,
		overlays,
		workspace,
		piUpdate,
	} = deps;

	function handleAgentInventoryChanged(nextAgents: AgentTab[]) {
		const previousPendingAgents = pendingAgentsRef.current;
		const remainingPendingAgents = previousPendingAgents.filter((pending) => !nextAgents.some((agent) => isReplacementForPendingAgent(agent, pending)));
		const pendingReplacementById = new Map(
			previousPendingAgents
				.map((pending) => {
					const replacement = nextAgents.find((agent) => isReplacementForPendingAgent(agent, pending));
					return replacement ? [pending.id, replacement.id] : undefined;
				})
				.filter((entry): entry is [string, string] => Boolean(entry)),
		);
		if (remainingPendingAgents.length !== previousPendingAgents.length) {
			pendingAgentsRef.current = remainingPendingAgents;
			setPendingAgents(remainingPendingAgents);
		}
		const draftIds = new Set([...nextAgents.map((agent) => agent.id), ...remainingPendingAgents.map((agent) => agent.id)]);
		// 终端状态清理统一由下方 useEffect([displayAgents]) 的 prune 负责：
		// 此处再调一次会在流式 runtime 更新时与 displayAgents effect 重复执行，
		// 形成不必要的 setState 链（历史日志：发送消息后 Maximum update depth）。
		livePromptByAgentRef.current = migrateAgentRecord(livePromptByAgentRef.current, pendingReplacementById, draftIds);
	}

	useEffect(() => {
		handleAgentInventoryChanged(agents);
	}, [agents]);

	const bootstrapProps = {
		onProjectsChanged: (next: Project[]) => {
			if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
		},
		onSettingsApplied: (next: AppSettings) => {
			setSettings(next);
			showToast(t("settings.restartNotice"));
		},
		onOpenInBrowser: openInBrowser,
		onTrustRequest: overlays.setTrustRequest,
		// 主进程焦点目标（通知点击/右键打开项目）：sessionId 走旧链路选中会话；
		// projectId/projectPath 由 useSessionWorkspaceChrome 的订阅处理（本回调只透传不重复消费）。
		onFocusTarget: (target: FocusTargetPayload) => {
			if (!("sessionId" in target)) return;
			const session = store.get(sessionRecordByIdAtomFamily(target.sessionId));
			if (session) selectSessionCommand(session.projectId, session.id, false);
		},
	};

	useEffect(() => {
		void workspace.loadExternalEditors().catch(() => undefined);
		void api.imagegen
			.getConfig()
			.then(setImageGenConfig)
			.catch(() => undefined);
		void api.settings
			.get()
			.then((next) => {
				setSettings(next);
				setSettingsLoaded(true);
				setEnhanceModel(next.enhanceModel ?? null);
				setEnhanceIncludeContext(next.enhanceIncludeContext === true);
				setPromptSuggestionEnabled(next.promptSuggestionEnabled !== false);
				setPromptSuggestionModel(next.promptSuggestionModel ?? null);
				piUpdate.setCustomPiPath(next.customPiPath ?? "");
				if (!Object.values(next.externalEditors).some((editor) => editor.command)) {
					void api.editors
						.redetect()
						.then((updated) => {
							setSettings(updated);
						})
						.then(() => workspace.loadExternalEditors())
						.catch(() => undefined);
				}
				if (!next.piEnvironmentChecked) {
					// 首次检测延后一帧启动,先让主界面完成绘制,避免 packaged app 打开时出现几秒白屏。
					window.setTimeout(() => {
						// 默认后端已是可用 DSH 时不再弹出「没有 pi」：只装 DSH 的用户不需要每次启动都被催装 pi。
						// 探针可能还没落地（checking），那就照常检测——宁可多问一次，不能把真正缺后端的用户闷死。
						if (next.defaultAgentBackend === "dsh" && store.get(dshRuntimeStatusAtom).state === "installed") return;
						void piUpdate.checkPiInstall("startup");
					}, 300);
				}
			})
			.catch(() => {
				// 即使 settings IPC 暂不可用，也要允许侧栏继续使用 localStorage/default 状态。
				setSettingsLoaded(true);
			});
	}, []);

	return { bootstrapProps };
}
