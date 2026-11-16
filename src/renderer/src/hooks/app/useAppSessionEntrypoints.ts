import { useCallback, useEffect, useRef } from "react";
import type { createStore } from "jotai";
import { acpToolsAtom, agentProfilesAtom, currentSessionIdAtom, pendingAgentBindingAtom, sessionCatalogLoadStateAtom, sessionDraftByIdAtom, sessionRecordByIdAtomFamily } from "../../atoms";
import { hostPluginCatalogAtom, isHostPluginPagePanel } from "../../atoms/host-plugin-atoms";
import type { FavoritesOpenSessionRequest } from "../../atoms/favorites-atoms";
import { buildAgentSessionTitle } from "../../components/agents/agentIconCodec";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import { isChatProject } from "../../rendererUtils";
import { GUIDE_BOOTSTRAP_SESSION_ID, readWelcomeDshModelPreference, readWelcomeModelPreference, readWelcomeThinkingPreference, resolveChatSessionBootstrap, type NewSessionBackendTarget } from "../../utils/chatSessionBootstrap";
import { createSessionOnce } from "../../utils/sessionCreation";
import type { NoticeKind } from "../../utils/notice";
import type { WorkspacePageId } from "../../utils/workspacePageTabs";
import { isRemoteProject } from "../../../../shared/projectLocation";
import type { AgentBackend, Project, SessionRecord } from "../../../../shared/types";
import { useHostPluginNavigation } from "../plugins/useHostPluginNavigation";
import type { SessionWorkspaceChrome } from "../useSessionWorkspaceChrome";

/**
 * 会话入口与引导页首发：划词回填、页面式工作区互斥、侧栏/插件/收藏页打开会话、
 * 引导页空白输入框（虚拟会话 GUIDE_BOOTSTRAP_SESSION_ID）首次发送落地成真实会话。
 *
 * 这些 effect 与回调都是「会话列同一时刻只呈现一层，且选中会话必登记 Tab」的同一条链路，
 * 集中在 App 级 hook 里保持唯一实现；页面组件（收藏页/插件页/定时任务页）各自经 atom 或
 * 回调触发，不自己选中会话。
 */
export interface AppSessionEntrypointsDeps {
	store: ReturnType<typeof createStore>;
	currentSessionId: string | undefined;
	activeProjectId: string | undefined;
	activeProject: Project | undefined;
	projects: Project[];
	effectiveAgentBackend: AgentBackend;
	setSessionDraft: (input: { sessionId: string; value: string | ((current: string) => string) }) => void;
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	selectSessionCommand: (projectId: string, sessionId: string, scrollToEnd?: boolean) => void;
	upsertSession: (session: SessionRecord) => void;
	promoteSessionComposerState: (input: { fromSessionId: string; toSessionId: string }) => void;
	promoteSessionMessagesCache: (input: { fromSessionId: string; toSessionId: string }) => void;
	workspaceChrome: SessionWorkspaceChrome;
	runOpenSidebarSessionById: (projectId: string, sessionId: string) => Promise<string | undefined>;
	openInBrowser: (url: string) => void;
	activeWorkspacePage: WorkspacePageId | null;
	deactivateWorkspacePage: () => void;
	hostPluginPanel: { pluginId: string; panelId: string } | null;
	setHostPluginPanel: (value: { pluginId: string; panelId: string } | null) => void;
	favoritesOpenSessionRequest: FavoritesOpenSessionRequest | null;
	setFavoritesOpenSessionRequest: (value: FavoritesOpenSessionRequest | null) => void;
	/** refreshProjectSessions 每次渲染换引用，自动加载类 effect 必须经 ref 取最新实现 */
	refreshProjectSessionsRef: { current: (projectId: string, silent?: boolean) => Promise<unknown> };
	/** 与「+」/侧栏新建共用的在途创建注册表（issue #481） */
	pendingDraftCreationRef: { current: Map<string, Promise<SessionRecord | undefined>> };
	lastCreatedDraftIdRef: { current: string | undefined };
	guideBootstrapPromotionRef: { current: Promise<string> | undefined };
}

export interface AppSessionEntrypoints {
	openSidebarSessionByIdWithTab: (projectId: string, sessionId: string, tabMode?: "preview" | "permanent") => Promise<string | undefined>;
	ensureSessionForSend: (sessionId: string, target?: NewSessionBackendTarget) => Promise<string>;
}

export function useAppSessionEntrypoints(deps: AppSessionEntrypointsDeps): AppSessionEntrypoints {
	const {
		store,
		currentSessionId,
		activeProjectId,
		activeProject,
		projects,
		effectiveAgentBackend,
		setSessionDraft,
		showToast,
		selectSessionCommand,
		upsertSession,
		promoteSessionComposerState,
		promoteSessionMessagesCache,
		workspaceChrome,
		runOpenSidebarSessionById,
		openInBrowser,
		activeWorkspacePage,
		deactivateWorkspacePage,
		hostPluginPanel,
		setHostPluginPanel,
		favoritesOpenSessionRequest,
		setFavoritesOpenSessionRequest,
		refreshProjectSessionsRef,
		pendingDraftCreationRef,
		lastCreatedDraftIdRef,
		guideBootstrapPromotionRef,
	} = deps;

	/**
	 * 系统级划词浮窗的「发送到 PiDeck」：把浮窗里的文本追加到当前会话输入框。
	 * 没有已选会话（引导页）时落到引导页草稿，行为与手动粘贴一致。
	 */
	useEffect(() => {
		return api.selectionTool.onInserted(({ text }) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			const targetSessionId = currentSessionId ?? GUIDE_BOOTSTRAP_SESSION_ID;
			const existing = store.get(sessionDraftByIdAtom)[targetSessionId] ?? "";
			setSessionDraft({ sessionId: targetSessionId, value: existing ? `${existing}\n\n${trimmed}` : trimmed });
			showToast(t("selectionTool.inserted"), 2400);
		});
	}, [currentSessionId, setSessionDraft, showToast, store]);

	// 页面式工作区（定时任务 / 智能体）与会话共用同一条 Tab 栏：用户点侧栏切会话/项目时
	// 只让页面「失活」（页面 Tab 与搜索/编辑状态保留），否则会出现「点了另一个会话，
	// 页面还盖在上面」的错觉（与 HostPluginPageOverlay 同约定；区别是它直接收起插件页）。
	const workspacePageScopeRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		const scope = `${activeProjectId ?? ""}|${currentSessionId ?? ""}`;
		if (workspacePageScopeRef.current === undefined) {
			workspacePageScopeRef.current = scope;
			return;
		}
		if (scope === workspacePageScopeRef.current) return;
		workspacePageScopeRef.current = scope;
		deactivateWorkspacePage();
	}, [activeProjectId, currentSessionId, deactivateWorkspacePage]);

	// 会话列同一时刻只呈现一层页面：打开工作区页面时收起页面式插件面板
	// （两者都占 absolute inset-0，叠在一起会互相遮挡，且插件伪 Tab 无法再被点开）。
	// 反方向（打开页面式面板时让页面失活）在 openHostPluginPanelAtom 里做，否则两边互相抵消。
	// 对话框/浮层面板不占会话列，不与页面互斥。
	useEffect(() => {
		if (!activeWorkspacePage || !hostPluginPanel) return;
		if (isHostPluginPagePanel(hostPluginPanel, store.get(hostPluginCatalogAtom).catalog)) setHostPluginPanel(null);
	}, [activeWorkspacePage, hostPluginPanel, setHostPluginPanel, store]);

	/** 侧栏/分支打开：选中成功后按 preview|permanent 登记 Tab */
	const openSidebarSessionByIdWithTab = useCallback(
		async (projectId: string, sessionId: string, tabMode: "preview" | "permanent" = "permanent") => {
			const openedId = await runOpenSidebarSessionById(projectId, sessionId);
			if (openedId) workspaceChrome.registerOpenSession(openedId, tabMode);
			return openedId;
		},
		[runOpenSidebarSessionById, workspaceChrome],
	);

	// 桌面插件发起的会话导航：broker 已验权限/归属，复用侧栏打开链路（选中 + 常驻 Tab）。
	// 插件页是临时页面，走纯选中会让会话没有任何 Tab 归属；与「定时任务」页查看会话同一条链路。
	useHostPluginNavigation((projectId, sessionId) => {
		void openSidebarSessionByIdWithTab(projectId, sessionId, "permanent");
	}, openInBrowser);

	// 收藏页「会话」条目：FavoritesPage 渲染在 SessionPaneServices 之外，经 atom 发导航请求，
	// 这里复用侧栏打开链路（选中 + 常驻 Tab），不引入第二条会话选中路径。
	useEffect(() => {
		if (!favoritesOpenSessionRequest) return;
		const request = favoritesOpenSessionRequest;
		// 先消费再打开：openSidebarSessionByIdWithTab 的身份会随 workspaceChrome 变化，
		// 不清空请求会在后续渲染里重复打开同一会话。
		setFavoritesOpenSessionRequest(null);
		void openSidebarSessionByIdWithTab(request.projectId, request.sessionId, "permanent").then((openedId) => {
			// 目标恰好是当前会话时 scope 不变，页面自身不会失活；打开成功后显式让收藏页让位。
			// 失败（会话已删除/项目读不到）时保留页面，用户还能看到收藏条目与提示。
			if (openedId) deactivateWorkspacePage();
		});
	}, [deactivateWorkspacePage, favoritesOpenSessionRequest, openSidebarSessionByIdWithTab, setFavoritesOpenSessionRequest]);

	useEffect(() => {
		if (!activeProject) return;
		const action = resolveChatSessionBootstrap({
			isChatProject: isChatProject(activeProject),
			currentSessionId,
			catalogStatus: store.get(sessionCatalogLoadStateAtom)[activeProject.id]?.status,
		});
		if (action.kind === "load") {
			void refreshProjectSessionsRef.current(activeProject.id).catch(() => undefined);
		}
	}, [activeProject, currentSessionId, store]);

	// 引导页空白输入框（虚拟会话 GUIDE_BOOTSTRAP_SESSION_ID）的落地钩子：
	// - 首次发送时创建真实 Catalog 会话（Chat 匿名 / 非 Chat draft）；
	// - 选择 ACP 时也立即创建（ACP 的 configOptions 只有 runtime 握手后才有，
	//   引导页没有 catalog record 无法预热，不建草稿就永远不自动加载/启动）。
	// 创建后把 composer 状态整体提升到新会话（promoteSessionComposerStateAtom），
	// 随后选中并登记 Tab，返回真实 sessionId；非虚拟会话直接透传（保持签名兼容）。
	// 并发发送（快速双击）复用 guideBootstrapPromotionRef 里的同一个提升 promise，
	// 避免建出两个会话。创建即用户意图，Chat 拉起 pi 是预期行为。
	const ensureSessionForSend = useCallback(
		async (sessionId: string, target?: NewSessionBackendTarget) => {
			if (sessionId !== GUIDE_BOOTSTRAP_SESSION_ID) return sessionId;
			if (guideBootstrapPromotionRef.current) return guideBootstrapPromotionRef.current;
			const project = projects.find((candidate) => candidate.id === activeProjectId);
			if (!project) {
				throw new Error(t("app.guideBootstrapUnavailable"));
			}
			const promotion = (async () => {
				// 「使用」带来的人：首次发送建会话时落地绑定。必须在选中会话之前完成——
				// 主进程按绑定在首次发送时拼角色设定，晚一步首条消息就不带人设。
				const pendingAgentId = store.get(pendingAgentBindingAtom);
				const pendingAgent = pendingAgentId ? store.get(agentProfilesAtom).find((profile) => profile.id === pendingAgentId) : undefined;
				// 引导页 picker 无 record 分支把显式选择存进 localStorage；创建时将模型交给
				// 主进程校验、将思考档位作为启动偏好带入。底栏展示和真实会话创建读取同一份值，
				// 避免出现「菜单看似切换，首次发送后又回到默认档位」。
				// 后端取引导页输入框当前选择（composer 经 ensureSessionId 传入，已做可用性
				// 回落）；没有显式选择就是设置默认后端。不再读 localStorage 的「上次选择」。
				// 远端项目只跑主机上的 pi：即使欢迎页残留 dsh/acp 偏好，也不能把本地 runtime 绑到远端项目。
				const draftBackend = isRemoteProject(project) ? "pi" : (target?.backend ?? effectiveAgentBackend);
				const acpToolId = target?.acpToolId;
				// 模型偏好按后端分开取（issue #253）：DSH 的模型是 host route 名，不在 models.json，
				// 必须作为显式 model 直接带给 host；pi 的偏好走 welcomeModel（launchDefaults 会按
				// models.json 校验存在性）。历史上 DSH 侧不读偏好，点选因此永远不生效。
				// ACP 的模型/思考由 agent CLI 自持（session/config options），PiDeck 的
				// models.json 偏好对它无意义：不传 welcomeModel/thinkingLevel，避免把 pi
				// 的偏好写进 ACP 草稿（与 sessionIpc createDraft 的 nonPiBackend 同口径）。
				const welcomeModel = draftBackend === "dsh" ? readWelcomeDshModelPreference()?.model : draftBackend === "pi" ? readWelcomeModelPreference()?.model : undefined;
				const welcomeThinking = draftBackend === "acp" ? undefined : readWelcomeThinkingPreference()?.thinkingLevel;
				// ACP 草稿标题用工具名（与项目「+」/Tab「+」的 createAcp 同观感），
				// 找不到工具时退回项目名。
				// 统一创建 draft 会话（Chat 项目也走普通会话、可保存）：创建不拉 pi，
				// selectSessionCommand 同步切页、立即进入会话页；匿名会话仅保留给侧栏
				// 「新建临时对话」入口（createAnonymousSessionWithTab）。
				// 默认后端跟随设置项（settings.defaultAgentBackend，默认 pi），
				// 且经 DSH runtime 安装态钳制——runtime 不可用时不会尝试建 dsh 会话。
				// 激活时 SessionRuntimeCoordinator.applyPreferences → DshAgentManager.setModel
				// 会把这条显式 model 落到 host（host 拒绝时降级并告警，不让创建失败）。
				const acpToolName = draftBackend === "acp" && acpToolId ? store.get(acpToolsAtom).find((candidate) => candidate.id === acpToolId)?.name : undefined;
				// 复用 Tab 栏「+」/ 侧栏新建正在创建的草稿（issue #481）：那条 IPC 还没回来时
				// 引导页首发若另建一条，Tab 栏会多出一个没人写过的空标签。创建失败（undefined）
				// 时照常自建——失败的那条本来就没落地，不该让首发跟着失败。
				const inFlightDraft = pendingDraftCreationRef.current.get(project.id);
				// 「+」/侧栏新建刚落地、并且已经顶掉引导页（currentSessionId 指向它）：这条发送
				// 来自即将卸载的输入框，消息要落进那条会话。只认「最近新建的那条」，用户手动
				// 切到的其它会话不会被误当成新建目标。
				const liveSessionId = store.get(currentSessionIdAtom);
				const adoptedSession = liveSessionId && liveSessionId === lastCreatedDraftIdRef.current ? store.get(sessionRecordByIdAtomFamily(liveSessionId)) : undefined;
				const adoptedDraft = inFlightDraft ? await inFlightDraft : adoptedSession;
				const session =
					adoptedDraft ??
					(await createSessionOnce(pendingDraftCreationRef.current, project.id, async () => {
						const created = await api.sessions.createDraft({
							projectId: project.id,
							title: pendingAgent ? buildAgentSessionTitle(pendingAgent) : draftBackend === "dsh" ? `${project.name} DSH` : (acpToolName ?? `${project.name} agent`),
							backend: draftBackend,
							...(draftBackend === "acp" && acpToolId ? { acpToolId } : {}),
							...(welcomeModel ? (draftBackend === "dsh" ? { model: welcomeModel } : { welcomeModel }) : {}),
							...(welcomeThinking ? { thinkingLevel: welcomeThinking } : {}),
						});
						upsertSession(created);
						return created;
					}));
				if (!session) throw new Error(t("app.sessionCreateFailed"));
				if (pendingAgent) {
					// 绑定失败不阻断发送（会话已存在，用户还能在输入框上方的提示条里再绑）；
					// 无论成败都清掉待绑定 id，避免下一轮新会话页继承上一个智能体。
					try {
						await api.agentProfiles.bindSession({ sessionId: session.id, agentId: pendingAgent.id });
					} catch (error) {
						showToast(t("agentMarket.useFailed", { error: error instanceof Error ? error.message : String(error) }), 5000, "error");
					}
					store.set(pendingAgentBindingAtom, null);
				}
				// 引导页发送时 useSessionSend 已把 user 消息乐观写入虚拟会话 cache；
				// 提升时搬到真实会话——否则切页后新会话空态与引导页视觉相同，
				// 要等 agent 启动、回复流入后页面才「动」，用户误以为发送没生效。
				// 虚拟会话的 cache 随之清空（见 promoteSessionMessagesCacheAtom）。
				promoteSessionMessagesCache({
					fromSessionId: GUIDE_BOOTSTRAP_SESSION_ID,
					toSessionId: session.id,
				});
				promoteSessionComposerState({
					fromSessionId: GUIDE_BOOTSTRAP_SESSION_ID,
					toSessionId: session.id,
				});
				selectSessionCommand(project.id, session.id, false);
				workspaceChrome.registerOpenSession(session.id, "permanent");
				return session.id;
			})();
			guideBootstrapPromotionRef.current = promotion;
			try {
				return await promotion;
			} finally {
				guideBootstrapPromotionRef.current = undefined;
			}
		},
		[activeProjectId, projects, promoteSessionComposerState, promoteSessionMessagesCache, selectSessionCommand, upsertSession, workspaceChrome, effectiveAgentBackend, store, showToast],
	);

	// 待绑定智能体只在「新会话页」有意义：一旦进入真实会话（含刚建好的），就丢掉——
	// 否则用户之后再回到引导页发消息，会把上一轮选过的智能体莫名绑上去。
	useEffect(() => {
		if (!currentSessionId) return;
		if (store.get(pendingAgentBindingAtom) === null) return;
		store.set(pendingAgentBindingAtom, null);
	}, [currentSessionId, store]);

	return { openSidebarSessionByIdWithTab, ensureSessionForSend };
}
