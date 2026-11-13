import { useMemo } from "react";
import { Code, Pencil, Terminal } from "lucide-react";
import { isLanWeb } from "../../desktopApi";
import { isChatProject } from "../../rendererUtils";
import { t } from "../../i18n";
import type { AppSettings, Project, SessionRecord, TerminalTarget } from "../../../../shared/types";
import type { SessionToolAction } from "../../components/session/SessionTabsBar";
import type { SessionPaneServices } from "../../components/session/SessionPaneServices";
import type { useSessionHistoryMutations } from "../useSessionHistoryMutations";
import type { useSessionRunControl } from "../session/useSessionRunControl";
import type { useQueuedPrompt } from "../useQueuedPrompt";
import type { useSessionWorkspaceChrome } from "../useSessionWorkspaceChrome";
import type { useWorkspacePanels } from "../useWorkspacePanels";
import type { useSessionTabsAssembly } from "./useSessionTabsAssembly";

/**
 * 会话栏共享服务（SessionPaneServices）与 Tab 栏工具开关的装配入参。
 *
 * App 只提供跨域取值：运行控制、历史消息变更、排队队列、终端外观这些都已由各自 hook 持有，
 * 这里按栏契约接线；服务形状见 components/session/SessionPaneServices.tsx。
 */
export interface AppSessionPaneServicesDeps {
	/** 设置子集：简洁导航、思考过程显隐、输入框功能隐藏清单。 */
	settings: Pick<AppSettings, "navigationMode" | "showThinking" | "hiddenComposerFeatures">;
	showToast: SessionPaneServices["showToast"];
	showNotice: SessionPaneServices["showNotice"];
	api: SessionPaneServices["api"];
	/** Tab 栏工具开关（草稿纸）状态与切换。 */
	scratchPad: { isOpen: boolean; toggle: () => void };
	terminalTarget: TerminalTarget | undefined;
	terminalOpen: boolean;
	setTerminalOpenForOwner: (open: boolean) => void;
	editorsOpen: boolean;
	activeAgent: { cwd?: string } | undefined;
	activeProject: Project | undefined;
	adjustMenuPos: (x: number, y: number, width?: number, height?: number) => { x: number; y: number };
	openExternalEditorChooser: ReturnType<typeof useWorkspacePanels>["openExternalEditorChooser"];
	/** Tab 状态/动作整组：预览晋升常驻、退出分屏。 */
	workspaceChrome: Pick<ReturnType<typeof useSessionWorkspaceChrome>, "promotePreview" | "exitSplit">;
	runControl: Pick<ReturnType<typeof useSessionRunControl>, "abortAgent" | "restartActiveAgent" | "getSessionRunCapabilities" | "runSessionControl" | "requestCloseAgentForSession" | "restartingAgentId" | "stoppingAgentId" | "activatingSessionId" | "reloadingSessionId">;
	history: Pick<ReturnType<typeof useSessionHistoryMutations>, "resendUserMessage" | "editMessage" | "deleteMessage" | "removeMessageImage" | "forkFromUserMessage" | "pendingHistoryMutation">;
	queue: Pick<ReturnType<typeof useQueuedPrompt>, "queuedPrompts" | "retractQueuedPromptForEdit" | "discardQueuedPrompt" | "setQueuedPromptBehavior" | "sendQueuedPromptNow" | "suppressSessionQueueAutoDrain">;
	terminal: Pick<SessionPaneServices, "terminalStatesByOwner" | "activeTerminalOwnerKey" | "setTerminalOpenByOwnerKey" | "setTerminalCollapsedByOwnerKey" | "setTerminalHeight" | "terminalSettings" | "onTerminalThemeChange"> & { availableTerminalHeight: number | undefined };
	getSessionRecord: (sessionId: string) => SessionRecord | undefined;
	setProxyDialogSessionId: (sessionId: string | null) => void;
	buildTabsSessionActions: ReturnType<typeof useSessionTabsAssembly>["buildTabsSessionActions"];
	createSessionDraftWithTab: (projectId?: string) => Promise<unknown>;
	openSidebarSessionByIdWithTab: (projectId: string, sessionId: string, tabMode?: "preview" | "permanent") => Promise<string | undefined>;
	openProviderLogin: SessionPaneServices["openProviderLogin"];
	jumpToAskSession: SessionPaneServices["focusAskSessionById"];
	ensureSessionForSend: SessionPaneServices["ensureSessionId"];
	enqueueSessionPrompt: SessionPaneServices["enqueueSessionPrompt"];
	insertQuickPrompt: SessionPaneServices["insertQuickPrompt"];
	displayAgents: SessionPaneServices["agents"];
	queueFlushBySessionRef: SessionPaneServices["queueFlushBySessionRef"];
	sessionDurationByAgent: SessionPaneServices["sessionDurationByAgent"];
	activeProjectId: SessionPaneServices["activeProjectId"];
	handleProjectGitChanged: SessionPaneServices["onProjectGitChanged"];
	validFilePaths: SessionPaneServices["validFilePaths"];
	environmentDialog: boolean;
	changeChatPath: SessionPaneServices["changeChatPath"];
	jumpToMessageRef: SessionPaneServices["jumpToMessageRef"];
	paneLayoutRefs: SessionPaneServices["layoutRefs"];
	handleOpenLinkedFile: SessionPaneServices["onOpenFile"];
	diffFilePath: SessionPaneServices["onDiffFile"];
	setPreviewImage: SessionPaneServices["onPreviewImage"];
}

export interface AppSessionPaneServices {
	/** 会话 Tab 栏右侧工具开关（草稿纸 / 终端 / 外部编辑器），与抽屉开关同排。 */
	sessionToolActions: SessionToolAction[];
	/** 分屏各栏共享的服务袋（memo，只在依赖变化时重建）。 */
	sessionPaneServices: SessionPaneServices;
}

/**
 * 会话栏服务装配：把 App 级的运行控制、历史变更、排队队列、终端外观接线成
 * `SessionPaneServices`，并生成 Tab 栏工具开关。
 *
 * 工具开关的闸门（无可用终端目标时隐藏、LAN Web 不出本机终端）与会话头部「⋯」菜单
 * 的按栏现算都在这一处，避免 App 与各栏入口各自漂移。
 */
export function useAppSessionPaneServices(deps: AppSessionPaneServicesDeps): AppSessionPaneServices {
	const { settings, showToast, showNotice, api, scratchPad, terminalTarget, terminalOpen, setTerminalOpenForOwner, editorsOpen, activeAgent, activeProject, adjustMenuPos, openExternalEditorChooser, workspaceChrome, runControl, history, queue, terminal, getSessionRecord, setProxyDialogSessionId, buildTabsSessionActions, createSessionDraftWithTab, openSidebarSessionByIdWithTab, openProviderLogin, jumpToAskSession, ensureSessionForSend, enqueueSessionPrompt, insertQuickPrompt, displayAgents, queueFlushBySessionRef, sessionDurationByAgent, activeProjectId, handleProjectGitChanged, validFilePaths, environmentDialog, changeChatPath, jumpToMessageRef, paneLayoutRefs, handleOpenLinkedFile, diffFilePath, setPreviewImage } = deps;
	const { abortAgent, restartActiveAgent, getSessionRunCapabilities, runSessionControl, requestCloseAgentForSession, restartingAgentId, stoppingAgentId, activatingSessionId, reloadingSessionId } = runControl;
	const { resendUserMessage, editMessage, deleteMessage, removeMessageImage, forkFromUserMessage, pendingHistoryMutation } = history;
	const { terminalStatesByOwner, activeTerminalOwnerKey, availableTerminalHeight, setTerminalOpenByOwnerKey, setTerminalCollapsedByOwnerKey, setTerminalHeight, terminalSettings, onTerminalThemeChange } = terminal;

	// 工具开关上收会话 Tab 栏（原右侧悬浮工具条入口的唯一挂载点）：
	// 草稿纸 / 终端 / 外部编辑器，与抽屉开关同排。
	// 终端按钮绑定 owner（agent 或项目），不再要求 agent 已激活；
	// web 预览 / 无可用目标（纯聊天无项目）时隐藏，避免指向无处可开的终端。
	const sessionToolActions: SessionToolAction[] = [
		{
			id: "scratch",
			label: t("scratchPad.openTooltip"),
			icon: <Pencil size={14} />,
			active: scratchPad.isOpen,
			onClick: () => scratchPad.toggle(),
		},
		...(!isLanWeb && terminalTarget
			? [
					{
						id: "terminal",
						label: t("app.terminal"),
						icon: <Terminal size={14} />,
						active: terminalOpen,
						onClick: () => {
							setTerminalOpenForOwner(!terminalOpen);
						},
					},
				]
			: []),
		{
			id: "editors",
			label: t("app.openWithEditor"),
			icon: <Code size={14} />,
			active: editorsOpen,
			onClick: (e) => {
				const projectPath = activeAgent?.cwd || (activeProject && !isChatProject(activeProject) ? activeProject.path : null);
				// 无项目目录也允许打开：编辑器入口在气泡内禁用并提示，
				// 文件管理器不依赖项目（空路径由主进程回退用户主目录）
				const anchor = adjustMenuPos(e.currentTarget.getBoundingClientRect().left - 4, e.currentTarget.getBoundingClientRect().bottom + 4, 240, 240);
				openExternalEditorChooser(projectPath || "", anchor);
			},
		},
	];
	const sessionPaneServices = useMemo(
		() => ({
			simpleNavigation: settings.navigationMode === "simple",
			isLanWeb,
			promoteSessionToPermanent: workspaceChrome.promotePreview,
			showToast,
			onOpenFile: handleOpenLinkedFile,
			onDiffFile: diffFilePath,
			onPreviewImage: setPreviewImage,
			abortAgent,
			restartActiveAgent,
			getSessionRunCapabilities,
			runSessionControl,
			// 会话头部「⋯」菜单（原 Tab 栏「⋯」）：会话操作 / 代理 / 工具开关按本栏 sessionId 现算。
			requestCloseAgentForSession,
			getSessionMenu: (sessionId: string) => ({
				sessionActions: buildTabsSessionActions(sessionId),
				toolActions: sessionToolActions,
				onOpenProxySetting: getSessionRecord(sessionId)?.backend !== "acp" ? () => setProxyDialogSessionId(sessionId) : undefined,
			}),
			stoppingAgentId,
			activatingSessionId,
			reloadingSessionId,
			openProviderLogin,
			runCreateSessionDraft: async () => {
				await createSessionDraftWithTab();
			},
			enqueueSessionPrompt,
			insertQuickPrompt,
			ensureSessionId: ensureSessionForSend,
			resendUserMessage,
			editMessage,
			deleteMessage,
			removeMessageImage,
			forkFromUserMessage,
			pendingHistoryMutation,
			openSidebarSessionById: async (projectId: string, sessionId: string) => {
				await openSidebarSessionByIdWithTab(projectId, sessionId, "permanent");
			},
			focusAskSessionById: jumpToAskSession,
			agents: displayAgents,
			queuedPromptsBySession: queue.queuedPrompts,
			queueRetract: queue.retractQueuedPromptForEdit,
			queueDiscard: queue.discardQueuedPrompt,
			queueChangeBehavior: queue.setQueuedPromptBehavior,
			queueSendNow: queue.sendQueuedPromptNow,
			// ACP 忙时「立即发送」= 先停当前回合（与输入框「停止」同一条 runSessionControl 链路）。
			queueStopTurn: (sessionId: string) => void runSessionControl(sessionId, "abort"),
			queueSuppressAutoDrain: queue.suppressSessionQueueAutoDrain,
			queueFlushBySessionRef,
			restartingAgentId,
			sessionDurationByAgent,
			activeProjectId,
			onProjectGitChanged: handleProjectGitChanged,
			showThinking: settings.showThinking,
			validFilePaths,
			terminalStatesByOwner,
			activeTerminalOwnerKey,
			availableTerminalHeight: availableTerminalHeight ?? 120,
			setTerminalOpenByOwnerKey,
			setTerminalCollapsedByOwnerKey,
			setTerminalHeight,
			terminalSettings,
			hiddenComposerFeatures: settings.hiddenComposerFeatures ?? [],
			onTerminalThemeChange,
			environmentDialog: Boolean(environmentDialog),
			showNotice,
			api,
			changeChatPath,
			jumpToMessageRef,
			layoutRefs: paneLayoutRefs,
			exitSessionSplit: workspaceChrome.exitSplit,
		}),
		[
			abortAgent,
			activeTerminalOwnerKey,
			activeProjectId,
			availableTerminalHeight,
			createSessionDraftWithTab,
			changeChatPath,
			deleteMessage,
			removeMessageImage,
			diffFilePath,
			displayAgents,
			editMessage,
			enqueueSessionPrompt,
			handleProjectGitChanged,
			ensureSessionForSend,
			environmentDialog,
			forkFromUserMessage,
			pendingHistoryMutation,
			handleOpenLinkedFile,
			insertQuickPrompt,
			isLanWeb,
			jumpToAskSession,
			jumpToMessageRef,
			openSidebarSessionByIdWithTab,
			paneLayoutRefs,
			queue.discardQueuedPrompt,
			queue.queuedPrompts,
			queue.retractQueuedPromptForEdit,
			queue.suppressSessionQueueAutoDrain,
			queueFlushBySessionRef,
			restartActiveAgent,
			restartingAgentId,
			getSessionRunCapabilities,
			runSessionControl,
			stoppingAgentId,
			activatingSessionId,
			reloadingSessionId,
			openProviderLogin,
			resendUserMessage,
			sessionDurationByAgent,
			settings.showThinking,
			settings.navigationMode,
			setPreviewImage,
			setTerminalCollapsedByOwnerKey,
			setTerminalHeight,
			onTerminalThemeChange,
			terminalSettings,
			settings.hiddenComposerFeatures,
			setTerminalOpenByOwnerKey,
			showToast,
			terminalStatesByOwner,
			availableTerminalHeight,
			validFilePaths,
			workspaceChrome.exitSplit,
			workspaceChrome.promotePreview,
		],
	);

	return { sessionToolActions, sessionPaneServices };
}
